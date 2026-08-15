/**
 * Vaults — savings goals, and one of the two surfaces here whose records keep a
 * page rather than a peek (`vaultDetailPath` in `lib/routes.ts` says why).
 */

export interface VaultRow {
  id: string;
  name: string;
  currentAmount: string | null;
  targetAmount: string;
  progress: number | null;
  color: string;
  currencySymbol: string;
}

function toNumber(value: string | number | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function vaultSaved(vault: Pick<VaultRow, 'currentAmount'>): number {
  return toNumber(vault.currentAmount);
}

/**
 * Progress as a percentage the bar can take, clamped to 0-100.
 *
 * The server's `progress` is deliberately *not* clamped — an over-funded vault
 * reports 140 and the detail screen says so in words. It is only the bar that
 * cannot draw past its own end, so the clamp lives at the point of drawing
 * rather than in the number.
 */
export function vaultProgress(vault: Pick<VaultRow, 'progress'>): number {
  return Math.min(Math.max(toNumber(vault.progress), 0), 100);
}

/** True once the goal is met — the one state worth calling out, because it is
 *  the point of having set a target. */
export function vaultIsMet(vault: Pick<VaultRow, 'progress'>): boolean {
  return toNumber(vault.progress) >= 100;
}

/** What is still to go, floored at zero: an over-funded vault needs nothing
 *  more, and "−$400 remaining" is a figure nobody reads correctly. */
export function vaultRemaining(vault: Pick<VaultRow, 'currentAmount' | 'targetAmount'>): number {
  return Math.max(toNumber(vault.targetAmount) - toNumber(vault.currentAmount), 0);
}

export function compareVaults(a: VaultRow, b: VaultRow, field: string, direction: string): number {
  const mult = direction === 'asc' ? 1 : -1;
  switch (field) {
    case 'name':
      return a.name.localeCompare(b.name) * mult;
    case 'saved':
      return (vaultSaved(a) - vaultSaved(b)) * mult;
    case 'progress':
      return (toNumber(a.progress) - toNumber(b.progress)) * mult;
    case 'target':
      return (toNumber(a.targetAmount) - toNumber(b.targetAmount)) * mult;
    default:
      return 0;
  }
}

/** The fields the detail screen reads off an attached holding. */
export interface VaultHoldingRow {
  holdingId: string;
  percentage: number;
  tokenSymbol: string;
  accountName: string;
  institutionName: string;
  attributedValue: string | null;
  holdingValue: string | null;
}

/**
 * What the vault actually counts from a holding: the attributed share, falling
 * back to the whole position only when the attribution has not been computed.
 * Null stays null — an unpriceable token renders "—" rather than zero, which
 * would silently understate the vault.
 */
export function attributedValue(holding: VaultHoldingRow): string | null {
  return holding.attributedValue ?? holding.holdingValue;
}

/** Largest contribution first; an unpriced holding sorts last rather than as
 *  zero, so it is visible at the bottom instead of buried among small ones. */
export function compareVaultHoldings(a: VaultHoldingRow, b: VaultHoldingRow): number {
  const left = attributedValue(a);
  const right = attributedValue(b);
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return toNumber(right) - toNumber(left);
}

/** The bounds `vaults.updateHoldingPercentage` accepts. */
export function isValidVaultPercentage(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= 100;
}
