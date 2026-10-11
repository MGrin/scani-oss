import {
  PaymentOccurrenceRepository,
  PaymentRepository,
  TokenRepository,
  VendorRepository,
} from '@scani/domain/repositories';
import { Decimal } from '@scani/shared';
import { Container } from 'typedi';
import type { BillsIcsEvent } from '../lib/bills-ics';

/** Unpaid bills this far back stay on the calendar: still money that has to move. */
const PAST_DAYS = 30;
/** The same year ahead the Bills calendar shows. */
const AHEAD_DAYS = 365;

function shiftDay(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A user's scheduled bills as calendar events (SC-1654): active payments only,
 * outflows only, and each occurrence named the way it would settle, by its own
 * payee, currency and direction when it carries them (SC-1401).
 */
export async function billCalendarEvents(userId: string, now: Date): Promise<BillsIcsEvent[]> {
  const payments = (await Container.get(PaymentRepository).findByUser(userId)).filter(
    (payment) => payment.status === 'active'
  );
  if (payments.length === 0) return [];

  const from = shiftDay(now, -PAST_DAYS);
  const to = shiftDay(now, AHEAD_DAYS);
  const paymentsById = new Map(payments.map((payment) => [payment.id, payment]));
  const occurrences = (
    await Container.get(PaymentOccurrenceRepository).findByPaymentIds(
      payments.map((payment) => payment.id)
    )
  )
    .flat()
    .filter(
      (occurrence) =>
        occurrence.status === 'scheduled' && occurrence.dueDate >= from && occurrence.dueDate <= to
    );

  const bills = occurrences.flatMap((occurrence) => {
    const payment = paymentsById.get(occurrence.paymentId);
    if (!payment) return [];
    if ((occurrence.settledDirection ?? payment.direction) !== 'outflow') return [];
    return [
      {
        occurrence,
        vendorId: occurrence.settledVendorId ?? payment.vendorId,
        currencyTokenId: occurrence.settledCurrencyTokenId ?? payment.currencyTokenId,
        amount: occurrence.expectedAmount ?? payment.expectedAmount,
      },
    ];
  });
  if (bills.length === 0) return [];

  const vendorNames = new Map(
    (await Container.get(VendorRepository).findByUser(userId)).map((vendor) => [
      vendor.id,
      vendor.displayName,
    ])
  );
  const symbols = new Map(
    (
      await Container.get(TokenRepository).findManyWithTypes([
        ...new Set(bills.map((bill) => bill.currencyTokenId)),
      ])
    ).map((token) => [token.id, token.symbol])
  );

  return bills
    .sort((a, b) => a.occurrence.dueDate.localeCompare(b.occurrence.dueDate))
    .map(({ occurrence, vendorId, currencyTokenId, amount }) => {
      const payee = vendorNames.get(vendorId) ?? 'Bill';
      const symbol = symbols.get(currencyTokenId) ?? '';
      return {
        uid: occurrence.id,
        date: occurrence.dueDate,
        summary:
          amount === null
            ? payee
            : `${payee} · ${new Decimal(amount).toFixed(2)}${symbol ? ` ${symbol}` : ''}`,
      };
    });
}
