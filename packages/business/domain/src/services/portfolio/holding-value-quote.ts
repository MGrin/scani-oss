import type { HoldingValueQuote } from '@scani/db/schema';
import { Decimal } from '@scani/shared';

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** A damaged or rolling-deploy projection takes the live path. */
export function compatibleHoldingQuote(
  row: {
    valueQuote: unknown;
    valueBase: string | null;
    valuePricedAt: Date | null;
    balance: string;
  },
  baseTokenId: string,
  at: Date
): HoldingValueQuote | null {
  const raw = row.valueQuote;
  if (typeof raw !== 'object' || raw === null) return null;
  const fields = raw as Record<string, unknown>;
  if (
    fields.version !== 1 ||
    typeof fields.baseTokenId !== 'string' ||
    !(fields.price === null || typeof fields.price === 'string') ||
    !(fields.source === null || typeof fields.source === 'string') ||
    !(fields.staleAfter === null || isInstant(fields.staleAfter)) ||
    !isInstant(fields.calculatedAt)
  )
    return null;
  const quote = raw as HoldingValueQuote;
  if (quote.baseTokenId !== baseTokenId || new Date(quote.calculatedAt) > at) return null;
  if (quote.price === null)
    return row.valueBase === null && row.valuePricedAt === null ? quote : null;
  if (row.valueBase === null || row.valuePricedAt === null) return null;
  try {
    const price = new Decimal(quote.price);
    return price.isFinite() && price.gte(0) && new Decimal(row.balance).mul(price).eq(row.valueBase)
      ? quote
      : null;
  } catch {
    return null;
  }
}
