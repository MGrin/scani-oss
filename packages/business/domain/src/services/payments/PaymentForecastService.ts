import { Container, Service } from 'typedi';
import { PaymentOccurrenceRepository } from '../../repositories/PaymentOccurrenceRepository';
import { PaymentRepository } from '../../repositories/PaymentRepository';
import { BaseService } from '../BaseService';
import { buildForecast, type Forecast, type ForecastPaymentInput } from './forecast';

/**
 * The book of recurring payments projected forward (SC-461), as facts: which
 * payment falls due when, for how much, and which amounts come from history
 * rather than from what the user declared. It is what `payments.scheduled`
 * answers.
 *
 * It no longer carries a runway, a liquid balance or an observed drain. SC-1396
 * retired the cashflow forecast and its affordability verdict, because a
 * whole-wealth projection built on incomplete recorded spending read missing
 * months as zero. The Planning page that replaced it was removed too (SC-1409),
 * so nothing projects future wealth.
 *
 * ## Why the window is twelve months
 *
 * Past twelve every date comes from the recurrence rule alone, and a schedule
 * built only on "the rule says so" is an extrapolation rather than a fact.
 */

/** The window the schedule answers for, in months. See the class doc. */
export const FORECAST_HORIZON_MONTHS = 12;

export interface PaymentForecast extends Forecast {
  /** `YYYY-MM-DD`, the day the series starts. */
  today: string;
  /** `YYYY-MM-DD`, inclusive. */
  horizonEnd: string;
  horizonMonths: number;
}

function startOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

@Service()
export class PaymentForecastService extends BaseService {
  private readonly paymentRepository = Container.get(PaymentRepository);
  private readonly occurrenceRepository = Container.get(PaymentOccurrenceRepository);

  constructor() {
    super('PaymentForecastService');
  }

  async forecast(userId: string): Promise<PaymentForecast> {
    const start = startOfUtcDay(new Date());
    const today = toDateString(start);
    const horizonEnd = toDateString(
      new Date(
        Date.UTC(
          start.getUTCFullYear(),
          start.getUTCMonth() + FORECAST_HORIZON_MONTHS,
          start.getUTCDate()
        )
      )
    );

    const payments = await this.paymentRepository.findByUser(userId);
    // Every payment, not just the active ones: `buildForecast` owns the
    // status rule, and handing it a pre-filtered list would move the pause
    // constraint out of the one place it is tested.
    const occurrences = await this.occurrenceRepository.findByPaymentIds(
      payments.map((payment) => payment.id)
    );

    const byPaymentId = new Map<string, ForecastPaymentInput['occurrences'][number][]>();
    for (const occurrence of occurrences) {
      const list = byPaymentId.get(occurrence.paymentId);
      // `actualAmount` travels with the row rather than being fetched
      // separately: `findByPaymentIds` already selects it, so SC-625's
      // history estimate costs this procedure no extra query. Dropping it
      // here was what made the input the forecast needs unreachable from the
      // function that needs it.
      const row = {
        dueDate: occurrence.dueDate,
        status: occurrence.status,
        expectedAmount: occurrence.expectedAmount,
        actualAmount: occurrence.actualAmount,
        settledCurrencyTokenId: occurrence.settledCurrencyTokenId,
        settledDirection: occurrence.settledDirection,
      };
      if (list) list.push(row);
      else byPaymentId.set(occurrence.paymentId, [row]);
    }

    const inputs: ForecastPaymentInput[] = payments.map((payment) => ({
      payment: {
        id: payment.id,
        direction: payment.direction,
        currencyTokenId: payment.currencyTokenId,
        expectedAmount: payment.expectedAmount,
        intervalUnit: payment.intervalUnit,
        intervalCount: payment.intervalCount,
        anchorDate: payment.anchorDate,
        status: payment.status,
        endDate: payment.endDate,
        estimateFromHistory: payment.estimateFromHistory,
      },
      occurrences: byPaymentId.get(payment.id) ?? [],
    }));

    return {
      ...buildForecast(inputs, today, horizonEnd),
      today,
      horizonEnd,
      horizonMonths: FORECAST_HORIZON_MONTHS,
    };
  }
}
