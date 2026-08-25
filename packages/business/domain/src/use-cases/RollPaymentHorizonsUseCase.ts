import type { DatabaseTransaction } from '@scani/db';
import { createComponentLogger } from '@scani/logging';
import { Container, Service } from 'typedi';
import { PaymentRepository } from '../repositories/PaymentRepository';
import { PaymentService } from '../services/payments/PaymentService';

const logger = createComponentLogger('use-case:roll-payment-horizons');

export interface RollPaymentHorizonsSummary {
  /** `YYYY-MM-DD` the forward edge was filled to. */
  horizonEnd: string;
  /** Active payments whose edge was short of `horizonEnd` — the denominator. */
  behind: number;
  /** Of those, how many actually gained occurrences. */
  rolled: number;
  /** Occurrence rows inserted across all of them. */
  occurrencesAdded: number;
  /** Payments whose roll threw. Non-zero fails the job after the sweep finishes. */
  failed: number;
  durationMs: number;
}

/**
 * Advance the forward edge of every active payment's materialised
 * schedule (SC-622).
 *
 * `payment_occurrences` is filled to `MATERIALISATION_HORIZON_MONTHS`
 * past the day a payment was last WRITTEN, and until this existed
 * nothing re-filled it: `create`, an amount edit and `resume` all
 * materialise as a side effect of their own write, and `PaymentService`
 * exposed a `materialise` that no router and no job ever called. So an
 * active payment nobody touched lost a month of its own future every
 * month — a bill created five months ago had seven months of rows, not
 * twelve — and every long-horizon read tapered toward zero at a
 * different month per payment. Near-term reads were unaffected, which
 * is why it went unnoticed.
 *
 * Idempotent by construction: the roll is a bulk insert with
 * `onConflictDoNothing` on `(payment_id, due_date)`, so a retry after a
 * partial sweep re-inserts nothing and a payment already at the horizon
 * is skipped by the query before that.
 *
 * One payment's failure does not abandon the rest — a rule that cannot
 * expand is one user's data problem, and letting it stop the sweep would
 * freeze every other user's horizon behind it. The count is thrown at
 * the end so the job still goes red.
 */
@Service()
export class RollPaymentHorizonsUseCase {
  private readonly paymentRepository = Container.get(PaymentRepository);
  private readonly paymentService = Container.get(PaymentService);

  async execute(transaction?: DatabaseTransaction): Promise<RollPaymentHorizonsSummary> {
    const start = Date.now();
    // Asked of the service rather than recomputed here, so the bound the
    // query selects against is the same one the generator fills to.
    const horizonEnd = this.paymentService.materialisationHorizonEnd().toISOString().slice(0, 10);
    const behind = await this.paymentRepository.findActiveNeedingHorizonRoll(
      horizonEnd,
      transaction
    );

    let rolled = 0;
    let occurrencesAdded = 0;
    let failed = 0;
    for (const payment of behind) {
      try {
        const inserted = await this.paymentService.materialise(payment, transaction);
        if (inserted.length > 0) {
          rolled += 1;
          occurrencesAdded += inserted.length;
        }
      } catch (error) {
        failed += 1;
        logger.error(
          { paymentId: payment.id, error: error instanceof Error ? error.message : String(error) },
          'Failed to roll a payment horizon'
        );
      }
    }

    const summary: RollPaymentHorizonsSummary = {
      horizonEnd,
      behind: behind.length,
      rolled,
      occurrencesAdded,
      failed,
      durationMs: Date.now() - start,
    };

    if (failed > 0) {
      // Logged before throwing: the throw is what makes the job red, and
      // without this the only record of what DID roll is discarded with it.
      logger.warn(summary, 'Payment horizon roll finished with failures');
      throw new Error(
        `Rolled ${rolled}/${behind.length} payment horizons to ${horizonEnd}; ${failed} failed`
      );
    }
    return summary;
  }
}
