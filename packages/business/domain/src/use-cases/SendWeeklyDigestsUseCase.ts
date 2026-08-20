import { EmailFacade } from '@scani/cloud-client/facades/email-facade';
import { renderWeeklyDigestEmail, SCANI_BRAND } from '@scani/email';
import { createComponentLogger } from '@scani/logging';
import { Container, Service } from 'typedi';
import { UserRepository } from '../repositories/UserRepository';
import { WeeklyDigestService } from '../services/digest/WeeklyDigestService';

const logger = createComponentLogger('use-case:weekly-digest');

/**
 * An account is not mailed a digest twice inside this window.
 *
 * The job's advisory lock stops two OVERLAPPING fires, which is a different
 * thing from stopping a second send: a run that mailed half the recipients and
 * then threw is retried by BullMQ, takes the lock cleanly because the first
 * attempt has ended, and mails everyone it already reached again.
 *
 * Three days — comfortably longer than any retry chain, comfortably shorter
 * than the seven between two legitimate digests.
 */
export const DIGEST_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

/** Recipients are processed in batches; each is independent. */
const USER_CONCURRENCY = 10;

export interface WeeklyDigestOptions {
  /** Where "Open Scani" goes. The app's public origin. */
  appUrl: string;
  /** The api's public origin — the host serving `/e/u/:token`. */
  unsubscribeBaseUrl: string;
}

export interface WeeklyDigestSummary {
  /** Verified, subscribed accounts with a base currency and no recent send. */
  candidates: number;
  /**
   * Candidates with no rollup row at all — an account that has connected
   * nothing, which is the ordinary case for most of the userbase.
   */
  skippedNoSnapshot: number;
  /**
   * Candidates whose newest rollup row is older than the digest will quote.
   * Separate from the count above because this one is an OPERATIONAL fault:
   * it climbs when the nightly rollup stops running, and it is the only
   * counter here that should ever be looked at with alarm.
   */
  skippedStaleSnapshot: number;
  /** Candidates whose portfolio is empty — SC-460's do-not-mail guardrail. */
  skippedNoHoldings: number;
  sent: number;
  failed: number;
  /** True when no public URLs were configured, so nothing was attempted. */
  unconfigured: boolean;
}

function emptySummary(): WeeklyDigestSummary {
  return {
    candidates: 0,
    skippedNoSnapshot: 0,
    skippedStaleSnapshot: 0,
    skippedNoHoldings: 0,
    sent: 0,
    failed: 0,
    unconfigured: false,
  };
}

/**
 * The weekly digest (SC-460): net worth and its change, the biggest movers,
 * bills due in the coming week, and anything waiting in the review queue.
 *
 * It exists because outside retention is zero. Of 15 accounts, 2 have ever
 * returned after 24 hours and both are the operator's own, while 7 have a real
 * portfolio nobody has looked at since 2026-07-09 (SC-450). This is the only
 * mechanism that reaches those accounts without waiting for someone to decide
 * to open the app.
 *
 * Two rules it must not break, both of them about the 15 people this is aimed
 * at being the only 15 the product has:
 *
 * 1. **Never mail an account with nothing to say.** `WeeklyDigestService`
 *    declines rather than rendering an empty letter, and this counts each
 *    reason separately.
 * 2. **The unsubscribe works in one click with no sign-in.** The link carries
 *    a per-user token and lands on a GET endpoint that needs no session.
 */
@Service()
export class SendWeeklyDigestsUseCase {
  private readonly users = Container.get(UserRepository);
  private readonly digests = Container.get(WeeklyDigestService);
  private readonly email = Container.get(EmailFacade);

  async execute(
    options: WeeklyDigestOptions,
    now: Date = new Date()
  ): Promise<WeeklyDigestSummary> {
    const summary = emptySummary();

    if (!options.appUrl || !options.unsubscribeBaseUrl) {
      // A refusal, not an empty result. Sending a digest whose unsubscribe
      // link points nowhere is worse than sending none, and "0 sent" over a
      // missing URL reads identically to "0 sent" over an idle userbase.
      logger.warn(
        '📭 weekly-digest: FRONTEND_URL / BACKEND_URL are not configured; no digests can be sent'
      );
      summary.unconfigured = true;
      return summary;
    }

    const candidates = await this.users.findDigestRecipients(
      new Date(now.getTime() - DIGEST_COOLDOWN_MS)
    );
    summary.candidates = candidates.length;

    for (let i = 0; i < candidates.length; i += USER_CONCURRENCY) {
      const batch = candidates.slice(i, i + USER_CONCURRENCY);
      const results = await Promise.all(
        batch.map((candidate) =>
          this.sendOne(candidate, options, now).catch((error) => {
            logger.warn(
              {
                userId: candidate.id,
                error: error instanceof Error ? error.message : error,
              },
              'Weekly digest failed for one user; continuing'
            );
            return 'failed' as const;
          })
        )
      );
      for (const result of results) {
        if (result === 'sent') summary.sent += 1;
        else if (result === 'failed') summary.failed += 1;
        else if (result === 'no-snapshot') summary.skippedNoSnapshot += 1;
        else if (result === 'stale-snapshot') summary.skippedStaleSnapshot += 1;
        else summary.skippedNoHoldings += 1;
      }
    }

    if (summary.skippedStaleSnapshot > 0) {
      logger.warn(
        { skippedStaleSnapshot: summary.skippedStaleSnapshot, candidates: summary.candidates },
        '🕓 Accounts skipped because their newest portfolio rollup is too old to quote — check the nightly rollup'
      );
    }
    return summary;
  }

  private async sendOne(
    candidate: {
      id: string;
      email: string;
      name: string;
      baseCurrencyId: string;
      unsubscribeToken: string;
    },
    options: WeeklyDigestOptions,
    now: Date
  ): Promise<'sent' | 'no-snapshot' | 'stale-snapshot' | 'no-holdings'> {
    const outcome = await this.digests.buildFor(candidate, now);
    if (outcome.skipped) return outcome.skipped;

    await this.email.sendBranded({
      to: candidate.email,
      brand: SCANI_BRAND,
      content: renderWeeklyDigestEmail({
        brand: SCANI_BRAND,
        name: candidate.name,
        digest: outcome.digest,
        appUrl: options.appUrl,
        unsubscribeUrl: `${options.unsubscribeBaseUrl.replace(/\/+$/, '')}/e/u/${candidate.unsubscribeToken}`,
      }),
    });
    // Only after the send resolves. Marking first would make a transport
    // failure look like a delivery and suppress the retry that should follow.
    await this.users.markDigestSent(candidate.id, now);
    return 'sent';
  }
}
