import { describe, expect, it } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { AUTH_MESSAGES, validateBearerToken } from '../../src/auth/api-key';
import type { CloudDb } from '../../src/db/connection';
import { pricingRouter } from '../../src/presentation/routers/pricing';
import { buildUnauthedContext } from '../helpers/test-context';

/**
 * SC-106: a revoked key answered "Bearer token required", the same
 * sentence as a request with no `Authorization` header at all. The one
 * failure a key-based product has to explain well was the one it
 * explained worst.
 *
 * Each case below asserts the caller can tell which refusal it hit. All
 * of them stay `UNAUTHORIZED` / 401.
 */

const ENV_TOKEN = 'env-superuser-token-0123456789';
// Any string exercises this path — `validateBearerToken` checks the `bearer `
// scheme and then SHA-256s whatever follows, so the token's shape is not
// load-bearing here. It is deliberately not key-shaped: a realistic-looking
// key in a fixture is what tripped push protection on the public repo, and a
// placeholder that cannot be mistaken for a credential costs nothing (SC-189).
const PRESENTED = 'not-a-real-key-placeholder';

interface KeyRow {
  id: string;
  ownerUserId: string;
  tenantId: string;
  tier: string;
  billingStatus: string;
  quotaMonthlyRequests: number | null;
  revokedAt: Date | null;
}

function keyRow(overrides: Partial<KeyRow> = {}): KeyRow {
  return {
    id: 'key-1',
    ownerUserId: 'user-1',
    tenantId: 'tenant-1',
    tier: 'free',
    billingStatus: 'active',
    quotaMonthlyRequests: null,
    revokedAt: null,
    ...overrides,
  };
}

/** Minimal stand-in for the two drizzle chains `verifyCloudApiKey` walks. */
function fakeCloudDb(rows: KeyRow[]): CloudDb {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => rows }) }) }),
    update: () => ({ set: () => ({ where: () => ({ catch: () => undefined }) }) }),
  } as unknown as CloudDb;
}

async function refusalMessage(
  authHeader: string | null,
  rows: KeyRow[] = []
): Promise<{ code: string; message: string }> {
  try {
    await validateBearerToken({
      authHeader,
      expectedToken: ENV_TOKEN,
      cloudDb: fakeCloudDb(rows),
    });
  } catch (err) {
    const trpc = err as TRPCError;
    return { code: trpc.code, message: trpc.message };
  }
  throw new Error('expected the credential to be refused');
}

describe('bearer refusals name their own cause', () => {
  it('says the header is missing only when it really is', async () => {
    const refusal = await refusalMessage(null);
    expect(refusal.code).toBe('UNAUTHORIZED');
    expect(refusal.message).toBe(AUTH_MESSAGES.missingHeader);
  });

  it('does not blame the header for an unrecognised key', async () => {
    const refusal = await refusalMessage(`Bearer ${PRESENTED}`, []);
    expect(refusal.message).toBe(AUTH_MESSAGES.unknownKey);
    expect(refusal.message).not.toContain('Bearer token required');
  });

  it('says a revoked key was revoked, and when', async () => {
    const revokedAt = new Date('2026-08-12T09:30:00.000Z');
    const refusal = await refusalMessage(`Bearer ${PRESENTED}`, [keyRow({ revokedAt })]);
    expect(refusal.code).toBe('UNAUTHORIZED');
    expect(refusal.message).toBe(AUTH_MESSAGES.revoked(revokedAt));
    expect(refusal.message).toContain('revoked on 2026-08-12');
  });

  it('distinguishes a suspended key from a cancelled one', async () => {
    const suspended = await refusalMessage(`Bearer ${PRESENTED}`, [
      keyRow({ billingStatus: 'suspended' }),
    ]);
    const cancelled = await refusalMessage(`Bearer ${PRESENTED}`, [
      keyRow({ billingStatus: 'cancelled' }),
    ]);
    expect(suspended.message).toBe(AUTH_MESSAGES.suspended);
    expect(cancelled.message).toBe(AUTH_MESSAGES.cancelled);
  });

  it('treats a key whose account was deleted as unrecognised', async () => {
    // `cloud_api_keys.owner_user_id` cascades on delete, so the row is
    // gone with the account. There is nothing left to distinguish it
    // from a key that was never issued — and saying more would let a
    // caller probe which tokens once existed.
    const refusal = await refusalMessage(`Bearer ${PRESENTED}`, []);
    expect(refusal.message).toBe(AUTH_MESSAGES.unknownKey);
  });

  it('names superuser-token expiry rather than the caller’s key', async () => {
    try {
      await validateBearerToken({
        authHeader: `Bearer ${ENV_TOKEN}`,
        expectedToken: ENV_TOKEN,
        expectedTokenExpiresAt: new Date('2020-01-01T00:00:00.000Z'),
        cloudDb: fakeCloudDb([]),
      });
      throw new Error('expected expiry to be refused');
    } catch (err) {
      expect((err as TRPCError).message).toBe(AUTH_MESSAGES.superuserExpired);
    }
  });
});

describe('bearerProcedure surfaces the context’s refusal', () => {
  it('re-throws the reason auth failed instead of a generic one', async () => {
    const revokedAt = new Date('2026-08-12T09:30:00.000Z');
    const caller = pricingRouter.createCaller(
      buildUnauthedContext({
        authFailure: new TRPCError({
          code: 'UNAUTHORIZED',
          message: AUTH_MESSAGES.revoked(revokedAt),
        }),
      })
    );
    await expect(
      caller.convertRate({ fromCurrency: 'USD', toCurrency: 'EUR' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: AUTH_MESSAGES.revoked(revokedAt) });
  });

  it('falls back to the missing-header message when nothing tried bearer auth', async () => {
    const caller = pricingRouter.createCaller(buildUnauthedContext());
    await expect(
      caller.convertRate({ fromCurrency: 'USD', toCurrency: 'EUR' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', message: AUTH_MESSAGES.missingHeader });
  });
});
