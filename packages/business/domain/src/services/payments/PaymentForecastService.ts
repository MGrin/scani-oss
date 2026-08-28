import { Container, Service } from 'typedi';
import { PaymentOccurrenceRepository } from '../../repositories/PaymentOccurrenceRepository';
import { PaymentRepository } from '../../repositories/PaymentRepository';
import { BaseService } from '../BaseService';
import { buildForecast, type Forecast, type ForecastPaymentInput } from './forecast';

/**
 * The cashflow forecast (SC-461): what the book of recurring payments says
 * will move over the next year, and what there is to move it out of.
 *
 * ## Why one procedure answers both halves
 *
 * Runway is `liquid ÷ burn`, so a surface that shows one without the other
 * shows nothing. Splitting them into two procedures would put the home
 * screen's one-line runway behind two round trips and — worse — let the two
 * halves be as-of different moments.
 *
 * ## Why the window is always twelve months
 *
 * The reader picks 3, 6 or 12 (SC-461, mgrin: 6 by default), but the RUNWAY
 * is not a property of that choice: "how long does this last" must not get a
 * different answer because somebody tapped a different tab. So the server
 * always answers for twelve and the horizon control is a client-side slice of
 * one cached payload. It also makes the toggle instant, which is the whole
 * reason `MoneyPage` issues its five queries on every segment.
 *
 * Twelve is also where honesty runs out: past it every date comes from the
 * recurrence rule alone, and a projection built only on "the rule says so" is
 * an extrapolation rather than a forecast. A book that is still solvent at
 * twelve months is reported as "more than twelve", never as a bigger number.
 */

/** The window the forecast answers for, in months. See the class doc. */
export const FORECAST_HORIZON_MONTHS = 12;

export interface PaymentForecast extends Forecast {
  /** `YYYY-MM-DD`, the day the series starts. */
  today: string;
  /** `YYYY-MM-DD`, inclusive. */
  horizonEnd: string;
  horizonMonths: number;
}

function startOfUtcToday(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
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
    const start = startOfUtcToday();
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
