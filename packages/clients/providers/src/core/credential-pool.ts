/**
 * `CredentialPool` — cross-user credential pool that backs **pool-
 * credentialed** reads (current/historical pricing, token-identity
 * enrichment) by borrowing any healthy user's credentials for a given
 * provider.
 *
 * The architectural premise is that the data behind some auth-gated
 * endpoints is provider-public (a BTC quote from Kraken or an AAPL
 * close from IBKR is the same regardless of *which* user's API key
 * unlocks it). Borrowing those credentials anonymously across the
 * platform turns a per-user gate into a shared resource.
 *
 * **Pool participation is automatic.** Every active row in
 * `user_integration_credentials` is eligible by construction — there's
 * no opt-in flag, UI toggle, or consent step in this PR. Self-
 * credentialed reads (balances, transactions, validation) bypass the
 * pool entirely and are typed-required-`credentialsRef` at the
 * capability-interface layer (see `WithUserCreds<T>` in `core/types.ts`)
 * — the compiler refuses to route a pool credential into a balance fetch.
 *
 * **Selection** is LRU + health-aware. Borrows pick the entry with the
 * smallest `lastBorrowedAt` (NULL sorts first, distributing brand-new
 * entries) among non-quarantined rows. Health policy:
 *   - `auth-failed`     → quarantine for 24h; bumps consecutiveFailures.
 *                         The owning user's own dashboard surfaces a
 *                         "needs reconnection" hint independently of the
 *                         pool — the pool just stops drawing from that
 *                         entry.
 *   - `rate-limited`    → quarantine for the namespace's rate-limit
 *                         window (registered at boot, defaults to 60s).
 *   - `transient-error` → bump counter, no quarantine.
 *   - `ok`              → reset consecutiveFailures, clear quarantine.
 *
 * **Audit.** Every borrow appends a row to `credential_pool_borrow_log`
 * (provider, user, duration, outcome). No read paths in this PR; a
 * future work session surfaces aggregate stats to users.
 *
 * **Direct/OSS mode.** With one user on the machine the pool is
 * effectively a no-op: the only candidate is the requesting user
 * themselves, which the provider handles via `ctx.credentialsRef`
 * before falling through to the pool. This file's behaviour is
 * identical across modes — only the population of the pool differs.
 */

import { getDb } from '@scani/db/connection';
import {
  credentialPoolBorrowLog,
  credentialPoolState,
  userIntegrationCredentials,
} from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { Service } from 'typedi';
import type { ProviderError } from './errors';
import type { DecryptedCredentials } from './types';

/**
 * The four outcomes a borrower reports back to the pool. They map 1:1
 * onto the `credential_pool_borrow_log.outcome` text column.
 */
export type BorrowOutcome = 'ok' | 'auth-failed' | 'rate-limited' | 'transient-error';

/**
 * Public handle a borrower receives. Plaintext credentials are exposed
 * directly because the borrower is going to issue an HTTP request with
 * them in the next instruction — there's no value in another layer of
 * indirection. Borrowers MUST NOT log this object verbatim.
 */
export interface BorrowedCredentialsHandle {
  readonly credentials: DecryptedCredentials;
  /** Whose credentials these are. Audit-only; never user-visible. */
  readonly userId: string;
  /** Institution row id these credentials belong to. */
  readonly institutionId: string;
}

/** Internal handle carries the bookkeeping the public one hides. */
interface BorrowedHandleInternal extends BorrowedCredentialsHandle {
  readonly providerKey: string;
  readonly borrowedAt: Date;
}

/**
 * The borrow object returned to a successful borrower. Caller MUST
 * call `release()` exactly once when done. Skipping release leaves the
 * row's bookkeeping (lastBorrowedAt, totalBorrowsCount) stale by one
 * borrow but doesn't break subsequent borrows — the next one's
 * UPDATE corrects the LRU ordering.
 */
export interface Borrow {
  handle: BorrowedCredentialsHandle;
  release(outcome: BorrowOutcome): void;
}

/**
 * Decrypt a stored credential. Wired by the app at boot (see
 * `setCredentialsResolver`) so this package stays free of the
 * AES-GCM encryption layer; `IntegrationCredentialsService` remains
 * the only place that can decrypt.
 */
export type CredentialsResolver = (
  userId: string,
  institutionId: string
) => Promise<DecryptedCredentials | null>;

@Service()
export class CredentialPool {
  private readonly logger = createComponentLogger('credential-pool');

  /** Provider-key → institution-id lookup. Populated at boot. */
  private readonly providerToInstitution = new Map<string, string>();

  /**
   * Per-provider rate-limit window in milliseconds, used as the
   * quarantine duration when an entry returns rate-limited. Populated
   * by each provider's rate-limiter setup at boot.
   */
  private readonly rateLimitWindowMs = new Map<string, number>();

  private static readonly DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
  private static readonly AUTH_QUARANTINE_MS = 24 * 60 * 60 * 1000;

  private resolveCredentials: CredentialsResolver | null = null;

  /**
   * Wire up the credentials resolver. Called once at boot from the
   * app's composition root, passing
   * `IntegrationCredentialsService.getDecryptedCredentials.bind(...)`.
   * The pool refuses to borrow until this is set — boot order is
   * resolver-first, then provider registration.
   */
  setCredentialsResolver(resolver: CredentialsResolver): void {
    this.resolveCredentials = resolver;
  }

  /**
   * Map a provider's `providerKey` to its database institution row.
   * Each provider's `boot()` calls this once after resolving its own
   * institution, so the pool can translate the borrow's `providerKey`
   * arg into the `institution_id` it queries `credential_pool_state`
   * with.
   */
  registerProviderInstitution(providerKey: string, institutionId: string): void {
    this.providerToInstitution.set(providerKey, institutionId);
  }

  /**
   * Tell the pool the rate-limit window for a namespace. Used when
   * an entry returns `rate-limited` — the pool quarantines for one
   * full window so the next borrow doesn't immediately retry into
   * the same back-off.
   */
  registerRateLimitWindow(providerKey: string, windowMs: number): void {
    this.rateLimitWindowMs.set(providerKey, windowMs);
  }

  /**
   * Borrow a healthy credential from the pool. Returns null when no
   * eligible entry exists for this provider — providers fall through
   * to their public endpoint (or return null upward) in that case.
   */
  async borrowCredentials(providerKey: string): Promise<Borrow | null> {
    if (!this.resolveCredentials) {
      throw new Error(
        'CredentialPool: setCredentialsResolver() must be called at boot before borrowCredentials()'
      );
    }
    const institutionId = this.providerToInstitution.get(providerKey);
    if (!institutionId) return null;

    const candidate = await this.pickCandidate(institutionId);
    if (!candidate) return null;

    const decrypted = await this.resolveCredentials(candidate.userId, institutionId);
    if (!decrypted) {
      // The credential row was deleted between the pick and the
      // resolve — the next borrow will skip this user automatically
      // (no row in user_integration_credentials, no row in pass 2
      // either). One-shot warn keeps the log meaningful without
      // flooding.
      this.logger.warn(
        { providerKey, userId: candidate.userId },
        'Pool entry resolved to no credentials — likely deleted; skipping'
      );
      return null;
    }

    const now = new Date();
    await this.bumpLastBorrowed(candidate.userId, institutionId, now);

    const handle: BorrowedHandleInternal = {
      credentials: decrypted,
      userId: candidate.userId,
      institutionId,
      providerKey,
      borrowedAt: now,
    };

    return {
      handle,
      release: (outcome) => {
        // Release is fire-and-forget: callers don't await it because
        // their hot path is the upstream HTTP response, not the pool
        // bookkeeping. Errors here are logged but never propagate.
        this.releaseHandle(handle, outcome).catch((err) => {
          this.logger.error(
            { err, providerKey, userId: handle.userId },
            'Failed to release pool entry — bookkeeping may be stale'
          );
        });
      },
    };
  }

  /**
   * Are there any borrowable entries for this provider right now?
   * Cheap-ish (one count query) — orchestrators use this to skip the
   * pool tier entirely when nothing's available rather than borrowing
   * just to discover that.
   */
  async isHealthy(providerKey: string): Promise<boolean> {
    return (await this.size(providerKey)) > 0;
  }

  /**
   * Number of borrowable entries (active credentials minus currently-
   * quarantined ones). Used by the admin dashboard / boot diagnostics.
   */
  async size(providerKey: string): Promise<number> {
    const institutionId = this.providerToInstitution.get(providerKey);
    if (!institutionId) return 0;
    const db = getDb();

    const activeCreds = await db
      .select({ userId: userIntegrationCredentials.userId })
      .from(userIntegrationCredentials)
      .where(
        and(
          eq(userIntegrationCredentials.institutionId, institutionId),
          eq(userIntegrationCredentials.isActive, true)
        )
      );

    if (activeCreds.length === 0) return 0;

    const quarantined = await db
      .select({ userId: credentialPoolState.userId })
      .from(credentialPoolState)
      .where(
        and(
          eq(credentialPoolState.institutionId, institutionId),
          gt(credentialPoolState.quarantinedUntil, new Date())
        )
      );

    const blocked = new Set(quarantined.map((r) => r.userId));
    return activeCreds.filter((r) => !blocked.has(r.userId)).length;
  }

  /** Map a `ProviderError.kind` onto a release outcome. */
  static outcomeForError(kind: ProviderError['kind']): BorrowOutcome {
    if (kind === 'auth-failed') return 'auth-failed';
    if (kind === 'rate-limited') return 'rate-limited';
    return 'transient-error';
  }

  // ============================================================
  // Internals
  // ============================================================

  /**
   * Two-pass selection:
   *   1. Existing `credential_pool_state` rows that aren't quarantined,
   *      ordered by `last_borrowed_at NULLS FIRST` (LRU).
   *   2. Fall through to `user_integration_credentials` for any active
   *      cred without a state row yet — first borrow lazy-creates the
   *      row at bookkeeping time.
   *
   * The two passes are needed because the partial index in the
   * migration only covers existing state rows; brand-new credentials
   * have no row until their first borrow.
   */
  private async pickCandidate(institutionId: string): Promise<{ userId: string } | null> {
    const db = getDb();
    const now = new Date();

    const stateRows = await db
      .select({
        userId: credentialPoolState.userId,
        lastBorrowedAt: credentialPoolState.lastBorrowedAt,
      })
      .from(credentialPoolState)
      .where(
        and(
          eq(credentialPoolState.institutionId, institutionId),
          or(
            isNull(credentialPoolState.quarantinedUntil),
            sql`${credentialPoolState.quarantinedUntil} < ${now}`
          )
        )
      )
      .orderBy(asc(credentialPoolState.lastBorrowedAt))
      .limit(1);

    if (stateRows[0]) {
      return { userId: stateRows[0].userId };
    }

    // No state row → either nothing's been borrowed yet for this
    // institution, or every state row is quarantined. Look for a
    // cred row that has no state row yet (first-time borrow path).
    const credRows = await db
      .select({ userId: userIntegrationCredentials.userId })
      .from(userIntegrationCredentials)
      .leftJoin(
        credentialPoolState,
        and(
          eq(credentialPoolState.userId, userIntegrationCredentials.userId),
          eq(credentialPoolState.institutionId, institutionId)
        )
      )
      .where(
        and(
          eq(userIntegrationCredentials.institutionId, institutionId),
          eq(userIntegrationCredentials.isActive, true),
          isNull(credentialPoolState.userId)
        )
      )
      .orderBy(asc(userIntegrationCredentials.createdAt))
      .limit(1);

    return credRows[0] ? { userId: credRows[0].userId } : null;
  }

  private async bumpLastBorrowed(userId: string, institutionId: string, now: Date): Promise<void> {
    const db = getDb();
    await db
      .insert(credentialPoolState)
      .values({
        userId,
        institutionId,
        lastBorrowedAt: now,
        totalBorrowsCount: 1,
      })
      .onConflictDoUpdate({
        target: [credentialPoolState.userId, credentialPoolState.institutionId],
        set: {
          lastBorrowedAt: now,
          totalBorrowsCount: sql`${credentialPoolState.totalBorrowsCount} + 1`,
        },
      });
  }

  private async releaseHandle(
    handle: BorrowedHandleInternal,
    outcome: BorrowOutcome
  ): Promise<void> {
    const db = getDb();
    const now = new Date();
    const durationMs = now.getTime() - handle.borrowedAt.getTime();

    // Append to audit log first so it's recorded even if the state
    // update fails.
    await db.insert(credentialPoolBorrowLog).values({
      providerKey: handle.providerKey,
      borrowedFromUserId: handle.userId,
      borrowedAt: handle.borrowedAt,
      durationMs,
      outcome,
    });

    if (outcome === 'ok') {
      await db
        .update(credentialPoolState)
        .set({ consecutiveFailures: 0, quarantinedUntil: null })
        .where(
          and(
            eq(credentialPoolState.userId, handle.userId),
            eq(credentialPoolState.institutionId, handle.institutionId)
          )
        );
      return;
    }

    const quarantineMs = this.quarantineMsForOutcome(outcome, handle.providerKey);
    const quarantinedUntil = quarantineMs ? new Date(now.getTime() + quarantineMs) : null;

    await db
      .update(credentialPoolState)
      .set({
        consecutiveFailures: sql`${credentialPoolState.consecutiveFailures} + 1`,
        totalFailuresCount: sql`${credentialPoolState.totalFailuresCount} + 1`,
        quarantinedUntil,
      })
      .where(
        and(
          eq(credentialPoolState.userId, handle.userId),
          eq(credentialPoolState.institutionId, handle.institutionId)
        )
      );
  }

  private quarantineMsForOutcome(outcome: BorrowOutcome, providerKey: string): number | null {
    switch (outcome) {
      case 'auth-failed':
        return CredentialPool.AUTH_QUARANTINE_MS;
      case 'rate-limited':
        return (
          this.rateLimitWindowMs.get(providerKey) ?? CredentialPool.DEFAULT_RATE_LIMIT_WINDOW_MS
        );
      case 'transient-error':
      case 'ok':
        return null;
    }
  }
}
