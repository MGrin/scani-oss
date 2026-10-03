import type { AssetAllocationDimension, AssetAllocationItem } from '@scani/shared';
import Decimal from 'decimal.js';

type DebtCandidate = {
  holding: { balance: string; isActive: boolean };
  token: { id: string };
};

type AllocatableHolding = DebtCandidate & {
  token: { symbol: string; name: string; typeId: string; typeCode: string; typeName: string };
  account: { id: string; name: string; typeCode: string; typeName: string };
  institution: { id: string; name: string; typeCode: string; typeName: string };
};

/** `key` is what holdings are summed under; only the type cut keys on something other than `id`. */
type Bucket = { key: string; id: string; code: string; name: string };

/**
 * Margin debt is negative cash (SC-1462). A slice of a bar cannot be negative,
 * so an active, priced holding worth less than zero is taken out and summed
 * instead (SC-1463). The rule does not look at the token type: a negative
 * anything must not become a slice.
 *
 * Inactive and unpriced holdings stay in `assets` untouched — they are neither
 * slice nor debt, and each caller already has its own rule for them.
 */
export function splitDebt<H extends DebtCandidate>(
  holdings: readonly H[],
  priceMap: Map<string, string>
): { assets: H[]; marginDebt: Decimal } {
  const assets: H[] = [];
  let marginDebt = new Decimal(0);
  for (const entry of holdings) {
    const value = activeValue(entry, priceMap);
    if (value?.isNegative()) {
      marginDebt = marginDebt.plus(value);
    } else {
      assets.push(entry);
    }
  }
  return { assets, marginDebt };
}

/**
 * The allocation slices for one dimension, and the margin debt kept beside
 * them. Each `percentage` is a share of gross assets — the sum of the slices —
 * so the slices add to 100 whatever the debt.
 */
export function aggregateAllocation(
  holdings: readonly AllocatableHolding[],
  priceMap: Map<string, string>,
  dimension: Exclude<AssetAllocationDimension, 'group'>
): { items: AssetAllocationItem[]; marginDebt: Decimal } {
  const { assets, marginDebt } = splitDebt(holdings, priceMap);
  const buckets = new Map<string, Bucket & { value: Decimal }>();

  for (const entry of assets) {
    const value = activeValue(entry, priceMap);
    if (!value) continue;
    const bucket = bucketFor(entry, dimension);
    const existing = buckets.get(bucket.key) ?? { ...bucket, value: new Decimal(0) };
    existing.value = existing.value.add(value);
    buckets.set(bucket.key, existing);
  }

  const gross = Array.from(buckets.values()).reduce(
    (sum, bucket) => sum.add(bucket.value),
    new Decimal(0)
  );
  const items = Array.from(buckets.values())
    .filter((bucket) => bucket.value.greaterThan(0))
    .sort((a, b) => b.value.comparedTo(a.value))
    .map((bucket) => ({
      id: bucket.id,
      code: bucket.code,
      name: bucket.name,
      value: bucket.value.toString(),
      percentage: shareOf(bucket.value, gross),
    }));

  return { items, marginDebt };
}

export function shareOf(value: Decimal.Value, gross: Decimal): string {
  return gross.greaterThan(0) ? new Decimal(value).div(gross).mul(100).toFixed(2) : '0';
}

/** `null` for a holding outside every figure: inactive, or with no price. */
function activeValue(entry: DebtCandidate, priceMap: Map<string, string>): Decimal | null {
  if (!entry.holding.isActive) return null;
  const price = priceMap.get(entry.token.id);
  if (!price) return null;
  return new Decimal(entry.holding.balance).mul(new Decimal(price));
}

function bucketFor(
  { token, account, institution }: AllocatableHolding,
  dimension: Exclude<AssetAllocationDimension, 'group'>
): Bucket {
  switch (dimension) {
    case 'token':
      return { key: token.id, id: token.id, code: token.symbol, name: token.name };
    case 'token_type':
      return { key: token.typeCode, id: token.typeId, code: token.typeCode, name: token.typeName };
    case 'account':
      return { key: account.id, id: account.id, code: account.name, name: account.name };
    case 'account_type':
      return {
        key: account.typeCode,
        id: account.typeCode,
        code: account.typeCode,
        name: account.typeName,
      };
    case 'institution':
      return {
        key: institution.id,
        id: institution.id,
        code: institution.name,
        name: institution.name,
      };
    case 'institution_type':
      return {
        key: institution.typeCode,
        id: institution.typeCode,
        code: institution.typeCode,
        name: institution.typeName,
      };
    default:
      throw new Error(`Unknown dimension: ${dimension satisfies never}`);
  }
}
