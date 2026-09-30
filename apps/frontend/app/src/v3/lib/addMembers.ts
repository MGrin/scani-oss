import type { MemberEntry } from './membership';

/** An account or a payee: ticking one brings its holdings or bills with it. */
export const isParentEntry = (entry: MemberEntry) =>
  entry.kind === 'account' || entry.kind === 'payee';

/** The ticked entry a member already comes with, if any. An account in a
 *  group brings all its holdings and a payee all its bills (SC-1408), so
 *  ticking one of those as well would add the same thing twice. */
export function coveringParentId(
  entry: MemberEntry,
  tickedParentIds: ReadonlySet<string>
): string | undefined {
  const parent =
    entry.kind === 'holding' ? entry.accountId : entry.kind === 'bill' ? entry.payeeId : undefined;
  return parent && tickedParentIds.has(parent) ? parent : undefined;
}

/** What a group add actually sends: what a ticked account or payee brings is dropped. */
export function entriesToAdd(chosen: readonly MemberEntry[]): MemberEntry[] {
  const parentIds = new Set(chosen.filter(isParentEntry).map((e) => e.id));
  return chosen.filter((entry) => !coveringParentId(entry, parentIds));
}

export type ShareIssue = 'missing' | 'tooPrecise' | 'overAvailable';

/** New shares are whole hundredths (the ruling on bus #17236); `available` is
 *  what the holding's other vaults leave free. */
export function shareIssue(share: number | undefined, available: number): ShareIssue | null {
  if (share === undefined || !Number.isFinite(share) || share <= 0) return 'missing';
  if (Math.abs(share * 100 - Math.round(share * 100)) > 1e-8) return 'tooPrecise';
  if (share > available + 1e-8) return 'overAvailable';
  return null;
}

interface Allocation {
  holdingId: string;
  vaultId: string;
  percentage: number;
}

/** Where the rest of a holding already counts: the other vaults, largest first. */
export function allocatedElsewhere(
  holdingId: string,
  vaultId: string,
  allocations: readonly Allocation[],
  vaultNames: ReadonlyMap<string, string>
): { name: string; percentage: number }[] {
  return allocations
    .filter((a) => a.holdingId === holdingId && a.vaultId !== vaultId && a.percentage > 0)
    .map((a) => ({ name: vaultNames.get(a.vaultId) ?? '', percentage: a.percentage }))
    .sort((a, b) => b.percentage - a.percentage);
}

/** The part of a holding's value a share brings to the vault. An unpriced
 *  holding stays unknown rather than reading as zero. */
export function shareValue(
  holdingValue: number | string | null,
  share: number | undefined
): number | null {
  if (holdingValue === null || share === undefined) return null;
  const value = Number(holdingValue);
  return Number.isFinite(value) ? (value * share) / 100 : null;
}
