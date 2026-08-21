import { EmailFacade } from '@scani/cloud-client/facades/email-facade';
import { renderIntegrationAlertEmail, SCANI_BRAND, type StaleIntegrationItem } from '@scani/email';
import { createComponentLogger } from '@scani/logging';
import { Container, Service } from 'typedi';
import {
  AlertDeliveryRepository,
  type AlertRecipient,
  type ClaimedAlert,
  InstitutionRepository,
  type StaleSyncTarget,
  type StaleWalletTarget,
  UserRepository,
  UserWalletRepository,
} from '../repositories';

const logger = createComponentLogger('use-case:integration-alerts');

/**
 * The rule this sweep evaluates. Written into every `alert_deliveries` row, so
 * it is part of the stored contract — renaming it orphans every open alert and
 * re-notifies the whole userbase.
 */
export const INTEGRATION_STALE_RULE = 'integration-stale';

/** Recipients are processed in batches; each is independent. */
const USER_CONCURRENCY = 10;

export interface IntegrationAlertOptions {
  /** The app's public origin — where "Reconnect" goes. */
  appUrl: string;
  /** The api's public origin — the host serving `/e/a/:token`. */
  unsubscribeBaseUrl: string;
  /** How long an integration must have been silent before the user hears about it. */
  staleAfterHours: number;
}

export interface IntegrationAlertSummary {
  /** Broken integrations found, across every account, eligible or not. */
  stale: number;
  /** Of those, the ones that are on-chain wallets rather than credentialed (SC-470). */
  staleWallets: number;
  /** Accounts holding at least one of them. */
  affectedUsers: number;
  /** Of those, the ones that may be mailed — verified, not opted out. */
  eligibleUsers: number;
  /** Integrations this run took ownership of and therefore owes an email. */
  claimed: number;
  /** Letters delivered. One per account, however many integrations it lists. */
  sent: number;
  failed: number;
  /** Open alerts closed because the integration is syncing again. */
  resolved: number;
  /** True when no public URLs were configured, so nothing was attempted. */
  unconfigured: boolean;
}

function emptySummary(): IntegrationAlertSummary {
  return {
    stale: 0,
    staleWallets: 0,
    affectedUsers: 0,
    eligibleUsers: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    resolved: 0,
    unconfigured: false,
  };
}

/**
 * One broken connection, flattened out of whichever probe found it.
 *
 * The two probes disagree about almost everything — what row is authoritative,
 * what "never synced" means, whether a credential is even involved — and none
 * of that survives to this point. What the rest of the sweep needs is a user, a
 * stable key to dedupe on, and a line of text; anything else here would make
 * the claim/send/resolve path grow a branch per source.
 */
interface AlertTarget {
  userId: string;
  /** Written into `alert_deliveries.dedupe_key`. Stable across runs, per fault. */
  dedupeKey: string;
  name: string;
  reason: StaleIntegrationItem['reason'];
}

/**
 * Tell a user their own integration has stopped syncing (SC-459).
 *
 * This is the first rule of the alert sweep, and it was chosen over the four
 * other candidates on the ticket because it is the only one with a cost the
 * user is paying TODAY. `stale-sync-probe` has detected exactly this every hour
 * for months and escalates it to Sentry — to us. The person whose net worth is
 * quietly missing a whole exchange is told nothing, and finds out by noticing
 * the number is wrong, which is the same as never.
 *
 * The signal is `InstitutionRepository.findStaleSyncTargets`, already proven in
 * production by that probe. What is new here is who hears about it, and the
 * ledger that stops them hearing about it twice.
 *
 * Three properties worth keeping when a second rule is added:
 *
 * 1. **One letter per account, not per integration.** Two connections breaking
 *    in the same night is one thing that happened, and two emails about it is
 *    the shape that gets a sender filtered.
 * 2. **The claim is written before the send** — see `AlertDeliveryRepository`.
 *    A crash suppresses; it never repeats.
 * 3. **A user who may not be mailed is never claimed for.** Claiming first and
 *    filtering after would burn the alert: the row would suppress forever and
 *    the account would never be told, including after they verify their email.
 */
@Service()
export class SendIntegrationAlertsUseCase {
  private readonly institutions = Container.get(InstitutionRepository);
  private readonly wallets = Container.get(UserWalletRepository);
  private readonly users = Container.get(UserRepository);
  private readonly deliveries = Container.get(AlertDeliveryRepository);
  private readonly email = Container.get(EmailFacade);

  async execute(
    options: IntegrationAlertOptions,
    now: Date = new Date()
  ): Promise<IntegrationAlertSummary> {
    const summary = emptySummary();

    if (!options.appUrl || !options.unsubscribeBaseUrl) {
      // A refusal, not an empty result — the same call SC-460 makes. An alert
      // whose unsubscribe link points nowhere is worse than no alert, and
      // "0 sent" over a missing URL reads identically to "0 sent" over a
      // healthy userbase.
      logger.warn(
        '📭 integration-alerts: FRONTEND_URL / BACKEND_URL are not configured; no alerts can be sent'
      );
      summary.unconfigured = true;
      return summary;
    }

    const cutoff = new Date(now.getTime() - options.staleAfterHours * 60 * 60 * 1000);
    // Both probes, one rule, one letter. A dead exchange and a dead wallet in
    // the same night is one thing that happened to the reader — splitting them
    // into two rules would mail them twice within the same second and would
    // also break `resolve` below, which takes the CURRENT truth for a whole
    // rule and deletes everything absent from it (SC-470).
    const [credentialed, staleWallets] = await Promise.all([
      this.institutions.findStaleSyncTargets(cutoff),
      this.wallets.findStaleWalletTargets(cutoff),
    ]);
    const targets = [...credentialed.map(fromCredential), ...staleWallets.map(fromWallet)];
    summary.stale = targets.length;
    summary.staleWallets = staleWallets.length;

    const byUser = new Map<string, AlertTarget[]>();
    for (const target of targets) {
      const bucket = byUser.get(target.userId);
      if (bucket) bucket.push(target);
      else byUser.set(target.userId, [target]);
    }
    summary.affectedUsers = byUser.size;

    const recipients = await this.users.findAlertRecipients([...byUser.keys()]);
    summary.eligibleUsers = recipients.length;

    for (let i = 0; i < recipients.length; i += USER_CONCURRENCY) {
      const batch = recipients.slice(i, i + USER_CONCURRENCY);
      const results = await Promise.all(
        batch.map((recipient) =>
          this.alertOne(recipient, byUser.get(recipient.id) ?? [], options, now).catch((error) => {
            logger.warn(
              {
                userId: recipient.id,
                error: error instanceof Error ? error.message : error,
              },
              'Integration alert failed for one user; continuing'
            );
            return { claimed: 0, sent: 0, failed: 1 };
          })
        )
      );
      for (const result of results) {
        summary.claimed += result.claimed;
        summary.sent += result.sent;
        summary.failed += result.failed;
      }
    }

    // Last, and over the WHOLE rule rather than only the accounts just mailed:
    // an account that opted out still has old open rows, and they must clear
    // when the integration recovers or a later break would find them present
    // and stay silent.
    summary.resolved = await this.deliveries.resolve(
      INTEGRATION_STALE_RULE,
      targets.map((t) => ({ userId: t.userId, dedupeKey: t.dedupeKey }))
    );

    return summary;
  }

  private async alertOne(
    recipient: AlertRecipient,
    targets: AlertTarget[],
    options: IntegrationAlertOptions,
    now: Date
  ): Promise<{ claimed: number; sent: number; failed: number }> {
    const claimed = await this.deliveries.claim(
      INTEGRATION_STALE_RULE,
      targets.map((t) => ({ userId: recipient.id, dedupeKey: t.dedupeKey })),
      now
    );
    if (claimed.length === 0) return { claimed: 0, sent: 0, failed: 0 };

    const base = options.unsubscribeBaseUrl.replace(/\/+$/, '');
    const appBase = options.appUrl.replace(/\/+$/, '');
    try {
      await this.email.sendBranded({
        to: recipient.email,
        brand: SCANI_BRAND,
        content: renderIntegrationAlertEmail({
          brand: SCANI_BRAND,
          name: recipient.name,
          integrations: describe(claimed, targets),
          integrationsUrl: `${appBase}/integrations`,
          unsubscribeUrl: `${base}/e/a/${recipient.unsubscribeToken}`,
          digestUnsubscribeUrl: `${base}/e/u/${recipient.unsubscribeToken}`,
        }),
      });
    } catch (error) {
      // Hand the claims back so the next fire retries, rather than making the
      // account wait out ALERT_CLAIM_TTL_MS for a transport blip.
      await this.deliveries.release(claimed.map((c) => c.id));
      throw error;
    }
    await this.deliveries.markSent(
      claimed.map((c) => c.id),
      now
    );
    return { claimed: claimed.length, sent: 1, failed: 0 };
  }
}

function fromCredential(target: StaleSyncTarget): AlertTarget {
  return {
    userId: target.userId,
    dedupeKey: target.credentialId,
    name: target.institutionName,
    reason: target.kind === 'orphaned-credential' ? 'never-synced' : 'stopped',
  };
}

/**
 * A wallet is named by the user's own label AND its chain, because neither
 * alone identifies it: the label is shared by every chain the address is
 * active on, and the chain is shared by every wallet they hold on it. The
 * credentialed side has no such problem — one Kraken is one Kraken.
 */
function fromWallet(target: StaleWalletTarget): AlertTarget {
  return {
    userId: target.userId,
    dedupeKey: target.accountId,
    name: `${target.walletLabel} (${target.institutionName})`,
    // 'never-synced' only when the account has genuinely never produced a
    // successful sync. Anything else worked once and then stopped, which is
    // the whole reason a cold wallet's silence is unreadable to its owner.
    reason: target.lastSync === null ? 'never-synced' : 'stopped',
  };
}

/**
 * The letter lists what this run CLAIMED, not everything currently broken.
 *
 * An integration the user was told about last week is still stale and still in
 * `targets`; repeating it is how a reader learns the alert is a status page
 * rather than news.
 */
function describe(claimed: ClaimedAlert[], targets: AlertTarget[]): StaleIntegrationItem[] {
  const byKey = new Map(targets.map((t) => [t.dedupeKey, t]));
  return claimed.flatMap((c) => {
    const target = byKey.get(c.dedupeKey);
    if (!target) return [];
    return [{ name: target.name, reason: target.reason }];
  });
}
