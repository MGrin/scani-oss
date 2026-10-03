import { EmailFacade } from '@scani/cloud-client/facades/email-facade';
import { renderActivationNudgeEmail, SCANI_BRAND } from '@scani/email';
import { createComponentLogger } from '@scani/logging';
import { Container, Service } from 'typedi';
import { type NudgeRecipient, UserRepository } from '../repositories/UserRepository';

const logger = createComponentLogger('use-case:activation-nudge');

/** How long after sign-up an account with nothing added is reminded (SC-1503). */
export const ACTIVATION_NUDGE_DELAY_MS = 3 * 24 * 60 * 60 * 1000;

export interface ActivationNudgeOptions {
  /** Where "Open Scani" goes. The app's public origin. */
  appUrl: string;
  /** The api's public origin, the host serving `/e/n/:token`. */
  unsubscribeBaseUrl: string;
  privacyUrl: string;
}

export interface ActivationNudgeSummary {
  candidates: number;
  sent: number;
  /** The send threw; the claim was given back, so the next run retries. */
  failed: number;
  /** Another run claimed it first. */
  alreadyClaimed: number;
  /** A URL was missing, so nothing was attempted. */
  unconfigured: boolean;
}

/**
 * One email, ever, to an account that signed up three days ago and has added
 * nothing (SC-1503). Seven of fourteen accounts were in that state when it was
 * written, and nothing reached them.
 *
 * **Never twice:** each account is claimed before the send with an `IS NULL`
 * update, so a second run or a BullMQ retry matches nothing.
 * **Never silently zero:** a failed send gives its claim back, so tomorrow's
 * run retries it, and every failure is counted and logged.
 */
@Service()
export class SendActivationNudgesUseCase {
  private readonly users = Container.get(UserRepository);
  private readonly email = Container.get(EmailFacade);

  async execute(
    options: ActivationNudgeOptions,
    now: Date = new Date()
  ): Promise<ActivationNudgeSummary> {
    const summary: ActivationNudgeSummary = {
      candidates: 0,
      sent: 0,
      failed: 0,
      alreadyClaimed: 0,
      unconfigured: false,
    };

    if (!options.appUrl || !options.unsubscribeBaseUrl || !options.privacyUrl) {
      logger.warn(
        '📭 activation-nudge: FRONTEND_URL / BACKEND_URL / the privacy URL are not configured; nothing was sent'
      );
      summary.unconfigured = true;
      return summary;
    }

    const candidates = await this.users.findActivationNudgeRecipients(
      new Date(now.getTime() - ACTIVATION_NUDGE_DELAY_MS)
    );
    summary.candidates = candidates.length;

    // One at a time: there are a handful a day, and a burst from one sender is
    // what a spam filter notices first.
    for (const candidate of candidates) {
      const outcome = await this.sendOne(candidate, options, now);
      summary[outcome] += 1;
    }

    if (summary.failed > 0) {
      logger.warn(
        { failed: summary.failed, candidates: summary.candidates },
        '⚠️ Activation nudges failed to send; their claims were released for the next run'
      );
    }
    return summary;
  }

  private async sendOne(
    candidate: NudgeRecipient,
    options: ActivationNudgeOptions,
    now: Date
  ): Promise<'sent' | 'failed' | 'alreadyClaimed'> {
    if (!(await this.users.claimActivationNudge(candidate.id, now))) return 'alreadyClaimed';
    try {
      await this.email.sendBranded({
        to: candidate.email,
        brand: SCANI_BRAND,
        content: renderActivationNudgeEmail({
          brand: SCANI_BRAND,
          name: candidate.name,
          language: candidate.language,
          appUrl: options.appUrl,
          unsubscribeUrl: `${options.unsubscribeBaseUrl.replace(/\/+$/, '')}/e/n/${candidate.unsubscribeToken}`,
          privacyUrl: options.privacyUrl,
        }),
      });
      return 'sent';
    } catch (error) {
      await this.users.releaseActivationNudge(candidate.id, now);
      logger.warn(
        { userId: candidate.id, error: error instanceof Error ? error.message : error },
        'Activation nudge failed for one user; claim released'
      );
      return 'failed';
    }
  }
}
