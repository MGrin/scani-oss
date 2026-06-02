/**
 * Pure spend math + shared spend types.
 *
 * Lives apart from `spend.ts` (which does the I/O) so the pricing model
 * and the manual-override merge can be unit-tested without touching the
 * network or Redis. Nothing in here calls `fetch`, `Date.now()`, or the
 * cache — every input arrives as an argument.
 */

export type SpendConfidence = 'actual' | 'invoiced' | 'estimated' | 'unknown';

export type SpendProvider = 'cloudflare' | 'fly' | 'neon' | 'upstash' | 'sentry';

export interface SpendLineItem {
  provider: SpendProvider;
  /** Display name (e.g. "Neon · scani (launch)"). */
  label: string;
  /** Amount in the line's `currency`. */
  amount: number;
  currency: string;
  confidence: SpendConfidence;
  /** Human period descriptor ("month-to-date 2026-06", "2026-05", …). */
  period: string;
  /** How the number was derived — surfaced in the table's Basis column. */
  basis?: string;
}

/**
 * An operator-entered actual bill for one provider in one billing month.
 * No vendor API exposes the authoritative invoice total for Neon or Fly,
 * so the operator records the figure off the real invoice; it supersedes
 * the estimate for that provider+period and renders as `actual`.
 */
export interface SpendOverride {
  provider: SpendProvider;
  /** Billing month, `YYYY-MM`. */
  period: string;
  amountUsd: number;
  note?: string;
  /** ISO timestamp of the last edit. */
  updatedAt: string;
  /** Audit actor that last wrote it. */
  actor?: string;
}

export interface SpendPeriodActuals {
  period: string;
  items: SpendOverride[];
  totalUsd: number;
}

export const PROVIDER_DISPLAY: Record<SpendProvider, string> = {
  cloudflare: 'Cloudflare',
  fly: 'Fly.io',
  neon: 'Neon',
  upstash: 'Upstash',
  sentry: 'Sentry',
};

export const SPEND_PROVIDERS: readonly SpendProvider[] = [
  'neon',
  'upstash',
  'fly',
  'cloudflare',
  'sentry',
];

// --- Neon usage-based pricing (neon.com/pricing, 2026-Q2). ---
//
// Neon's Launch/Scale plans bill metered usage from the first unit —
// there is NO flat base fee and NO "included compute hours". The earlier
// "$19 base + $0.16/hr overage past 300 hours" model under-reported the
// bill (a month under 300 hours showed only the $19 base). Pricing one
// month of real consumption with the constants below reproduced the
// actual invoice to the cent.
//
// Storage/egress metrics arrive as *bytes* and are metered per **decimal
// GB** (10⁹). Verified against a real Neon invoice: 93,552,000 bytes-month
// of root-branch storage billed as "0.093552 GB-month" — i.e. bytes ÷ 10⁹,
// not ÷ 1024³.
const GB = 1e9;

export const NEON_RATES = {
  computeUsdPerCuHour: { launch: 0.106, scale: 0.222 } as Record<string, number>,
  storageUsdPerGbMonth: 0.35,
  snapshotUsdPerGbMonth: 0.09,
  instantRestoreUsdPerGbMonth: 0.2,
  egressUsdPerGb: 0.1,
  /** First 100 GB of public egress are free each month. */
  egressFreeGb: 100,
} as const;

export interface NeonUsage {
  projectId: string;
  plan: string;
  computeUnitSeconds: number;
  storageBytesMonth: number;
  snapshotBytesMonth: number;
  instantRestoreBytesMonth: number;
  egressBytes: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Compute rate for a plan tier; unknown/free tiers compute at $0. */
function neonComputeRate(plan: string): number {
  const tier = plan.toLowerCase();
  if (tier.includes('scale')) return NEON_RATES.computeUsdPerCuHour.scale;
  if (tier.includes('launch')) return NEON_RATES.computeUsdPerCuHour.launch;
  return 0;
}

/**
 * Price one project's month-to-date Neon consumption. Returns the dollar
 * amount plus a human basis string. Free-tier projects (no priced
 * compute rate and no usage) come back at $0.
 */
export function priceNeonUsage(usage: NeonUsage): { amountUsd: number; basis: string } {
  const computeHours = usage.computeUnitSeconds / 3600;
  const computeRate = neonComputeRate(usage.plan);
  const storageGb = usage.storageBytesMonth / GB;
  const snapshotGb = usage.snapshotBytesMonth / GB;
  const restoreGb = usage.instantRestoreBytesMonth / GB;
  const egressGb = usage.egressBytes / GB;
  const billableEgressGb = Math.max(0, egressGb - NEON_RATES.egressFreeGb);

  const computeUsd = computeHours * computeRate;
  const storageUsd = storageGb * NEON_RATES.storageUsdPerGbMonth;
  const snapshotUsd = snapshotGb * NEON_RATES.snapshotUsdPerGbMonth;
  const restoreUsd = restoreGb * NEON_RATES.instantRestoreUsdPerGbMonth;
  const egressUsd = billableEgressGb * NEON_RATES.egressUsdPerGb;

  const amountUsd = round2(computeUsd + storageUsd + snapshotUsd + restoreUsd + egressUsd);

  const parts = [
    `${computeHours.toFixed(1)} CU-h × $${computeRate}/h = $${computeUsd.toFixed(2)}`,
    `${storageGb.toFixed(2)} GB-mo storage = $${storageUsd.toFixed(2)}`,
  ];
  if (snapshotUsd > 0) parts.push(`snapshots $${snapshotUsd.toFixed(2)}`);
  if (restoreUsd > 0) parts.push(`restore $${restoreUsd.toFixed(2)}`);
  parts.push(
    billableEgressGb > 0
      ? `${egressGb.toFixed(1)} GB egress (${billableEgressGb.toFixed(1)} billable) = $${egressUsd.toFixed(2)}`
      : `${egressGb.toFixed(1)} GB egress (under ${NEON_RATES.egressFreeGb} GB free)`
  );
  return { amountUsd, basis: parts.join(' · ') };
}

/**
 * Replace estimated/invoiced line items with operator-entered actuals
 * wherever an override exists for the displayed `period`. An override
 * for a provider drops every computed line for that provider and adds a
 * single `actual` line — the operator's number is authoritative.
 */
export function applyOverrides(
  items: SpendLineItem[],
  overrides: SpendOverride[],
  period: string
): SpendLineItem[] {
  const forPeriod = overrides.filter((o) => o.period === period);
  if (forPeriod.length === 0) return items;

  const overridden = new Set(forPeriod.map((o) => o.provider));
  const kept = items.filter((i) => !overridden.has(i.provider));
  for (const o of forPeriod) {
    kept.push({
      provider: o.provider,
      label: `${PROVIDER_DISPLAY[o.provider]} · actual bill`,
      amount: o.amountUsd,
      currency: 'USD',
      confidence: 'actual',
      period: o.period,
      basis: `Operator-entered actual${o.note ? ` — ${o.note}` : ''}`,
    });
  }
  return kept;
}

/**
 * Group every recorded override into a per-month ledger, newest month
 * first, with a USD total per month. Powers the "Recorded actual bills"
 * table — the place the operator's real monthly invoices live.
 */
export function groupOverridesByPeriod(overrides: SpendOverride[]): SpendPeriodActuals[] {
  const byPeriod = new Map<string, SpendOverride[]>();
  for (const o of overrides) {
    const list = byPeriod.get(o.period);
    if (list) list.push(o);
    else byPeriod.set(o.period, [o]);
  }
  return Array.from(byPeriod.entries())
    .map(([period, list]) => ({
      period,
      items: list.slice().sort((a, b) => a.provider.localeCompare(b.provider)),
      totalUsd: round2(list.reduce((acc, o) => acc + o.amountUsd, 0)),
    }))
    .sort((a, b) => b.period.localeCompare(a.period));
}

export function confidenceOrder(c: SpendConfidence): number {
  return c === 'actual' ? 0 : c === 'invoiced' ? 1 : c === 'estimated' ? 2 : 3;
}
