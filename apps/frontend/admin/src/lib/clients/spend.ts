import { cached } from '../cache';
import { type Result, tryCatch } from '../result';
import { type CfBillingHistoryItem, getBillingHistory } from './cloudflare';
import { type FlyMachine, getFlyMachines, getFlyOverview } from './fly';
import { getNeonConsumption, getNeonOverviewSummary } from './neon';
import { getSpendOverrides } from './spend-overrides';
import {
  applyOverrides,
  confidenceOrder,
  groupOverridesByPeriod,
  PROVIDER_DISPLAY,
  priceNeonUsage,
  type SpendLineItem,
  type SpendOverride,
  type SpendPeriodActuals,
} from './spend-pricing';
import { getUpstashDatabases, getUpstashStats } from './upstash';

/**
 * Monthly-spend rollup across every infra provider Scani pays for.
 *
 * The page is honest about what's known vs. what's modelled — every
 * line item carries a `confidence` chip:
 *
 *   - `actual`    → an operator-entered figure off the real invoice
 *                   (manual override). Authoritative; supersedes the
 *                   estimate for that provider in the displayed month.
 *   - `invoiced`  → pulled from a billing endpoint that reports real
 *                   charges (Cloudflare billing history; Upstash's
 *                   `total_monthly_billing`).
 *   - `estimated` → computed from the current period's usage counters
 *                   times public-tier pricing (Neon, Fly). Neon's
 *                   consumption API reconciles to the cent; Fly has no
 *                   billing API at all, so its estimate is an upper bound.
 *   - `unknown`   → the upstream API doesn't expose enough to compute a
 *                   number. Operator must check the vendor dashboard.
 *
 * Public pricing as of 2026-Q2. Neon rates live in `spend-pricing.ts`
 * (`NEON_RATES`); Fly rates are in `FLY_PRICING` below. The page surfaces
 * both on a "Pricing assumptions" card.
 *
 * IMPORTANT: every live API here reports *current* month-to-date only —
 * none expose a past month's invoice. Last month's real bill reaches the
 * page solely through the operator-entered overrides ("Recorded actual
 * bills"), never from these calls.
 */

export type {
  SpendConfidence,
  SpendLineItem,
  SpendOverride,
  SpendPeriodActuals,
  SpendProvider,
} from './spend-pricing';

export interface SpendSummary {
  /** Billing month the live rollup represents, `YYYY-MM`. */
  period: string;
  /** Sum of all confident line items (actual + invoiced + estimated) in USD. */
  totalUsd: number;
  /** Actual + invoiced — real money the vendors (or the invoice) reported. */
  invoicedUsd: number;
  estimatedUsd: number;
  lineItems: SpendLineItem[];
  /** Every recorded actual bill, grouped by month (newest first). */
  recordedActuals: SpendPeriodActuals[];
  /** Pricing constants surfaced for the "Assumptions" card. */
  assumptions: Array<{ label: string; rate: string; source: string }>;
}

// --- Fly.io published Pay-as-you-go rates (fly.io/docs/about/pricing/). ---
//   - `shared-cpu`:  $0.0000022 per vCPU-second.
//   - `performance`: $0.000016 per vCPU-second.
//   - RAM:           $0.00000193 per GB-second (independent of cpu kind).
// No base fee — Fly bills purely on resource time. Per-machine cost is
//   (cpu_rate * cpus + ram_rate * memory_gb) * seconds_running_this_month
// assuming each machine ran continuously since max(created_at, month_start)
// — an upper bound (over-estimates if machines were stopped). Fly exposes
// no billing total via API, so this is the closest programmatic figure;
// record the real invoice as an override for an exact number.
const FLY_PRICING = {
  sharedCpuRateUsdPerSec: 0.0000022,
  performanceCpuRateUsdPerSec: 0.000016,
  ramRateUsdPerGbSec: 0.00000193,
} as const;

export async function getSpendSummary(): Promise<Result<SpendSummary>> {
  return tryCatch(() =>
    cached('spend:summary', 300, async () => {
      const now = new Date();
      const monthStart = startOfUtcMonth(now);
      const period = periodKey(now);
      const periodLabel = `month-to-date ${period}`;

      const [cfHistory, neonUsage, neonNames, upstash, fly, overridesRes] = await Promise.all([
        getBillingHistory(),
        getNeonConsumption(monthStart.toISOString(), now.toISOString()),
        getNeonOverviewSummary(),
        getUpstashDatabases(),
        getFlyOverview(),
        getSpendOverrides(),
      ]);

      // Pull machine lists for every Fly app, in parallel, only if the
      // org call succeeded. Cached at 30s by the underlying client so
      // the Spend page + /platform/fly page don't double-fetch.
      const flyMachinesByApp = new Map<string, FlyMachine[]>();
      if (fly.ok) {
        const machineResults = await Promise.all(
          fly.data.apps.map(async (app) => ({
            app: app.name,
            res: await getFlyMachines(app.name),
          }))
        );
        for (const { app, res } of machineResults) {
          if (res.ok) flyMachinesByApp.set(app, res.data);
        }
      }

      const lineItems: SpendLineItem[] = [];

      // ----- Cloudflare: real invoiced amounts -----
      if (cfHistory.ok) {
        for (const item of cfHistory.data.filter(isCurrentMonth)) {
          lineItems.push(toCloudflareLine(item));
        }
      } else {
        lineItems.push(
          unknownLine('cloudflare', 'Cloudflare (billing API)', periodLabel, cfHistory.error)
        );
      }

      // ----- Neon: usage-based estimate from the consumption API -----
      // Prices each project's month-to-date CU-seconds + storage + egress
      // with current Launch/Scale rates. Reconciles to the invoice to the
      // cent (the old "$19 base + overage past 300h" model under-reported).
      if (neonUsage.ok) {
        const nameById = new Map(
          (neonNames.ok ? neonNames.data : []).map((p) => [p.id, p.name] as const)
        );
        for (const usage of neonUsage.data) {
          const { amountUsd, basis } = priceNeonUsage(usage);
          const name = nameById.get(usage.projectId) ?? usage.projectId;
          lineItems.push({
            provider: 'neon',
            label: `Neon · ${name} (${usage.plan})`,
            amount: amountUsd,
            currency: 'USD',
            confidence: 'estimated',
            period: periodLabel,
            basis,
          });
        }
      } else {
        lineItems.push(unknownLine('neon', 'Neon (consumption API)', periodLabel, neonUsage.error));
      }

      // ----- Upstash: real charge from `total_monthly_billing` -----
      // The stats endpoint already sums commands + storage into a dollar
      // figure; we show it verbatim instead of re-deriving an estimate.
      if (upstash.ok) {
        const usageResults = await Promise.all(
          upstash.data.map(async (db) => ({ db, usage: await getUpstashStats(db.id) }))
        );
        for (const { db, usage } of usageResults) {
          if (!usage.ok) {
            lineItems.push(
              unknownLine('upstash', `Upstash · ${db.name}`, periodLabel, usage.error)
            );
            continue;
          }
          lineItems.push({
            provider: 'upstash',
            label: `Upstash · ${db.name}`,
            amount: usage.data.monthlyBillingUsd,
            currency: 'USD',
            confidence: 'invoiced',
            period: periodLabel,
            basis: `Upstash billing API · ${formatCount(usage.data.monthlyRequests)} cmds, ${formatBytes(usage.data.storageBytes)} stored`,
          });
        }
      } else {
        lineItems.push(
          unknownLine('upstash', 'Upstash (databases API)', periodLabel, upstash.error)
        );
      }

      // ----- Fly: per-machine compute cost since month-start -----
      // Only `started` machines accrue compute — Fly doesn't bill CPU/RAM
      // for stopped/suspended ones. Even so this is a loose UPPER BOUND:
      // it assumes each running machine has been up continuously since
      // max(created_at, month_start), but Fly auto-stops idle machines, so
      // real running-seconds are typically lower. The Machines API exposes
      // no run-time accounting and Fly has no billing API at all — record
      // the invoice as an actual for the true figure.
      if (fly.ok && flyMachinesByApp.size > 0) {
        let totalComputeUsd = 0;
        let billedMachines = 0;
        const perAppBreakdown: string[] = [];
        for (const [app, machines] of flyMachinesByApp.entries()) {
          let appUsd = 0;
          for (const m of machines) {
            if (m.state !== 'started') continue;
            const seconds = secondsBilledThisMonth(m.createdAt, monthStart, now);
            if (seconds <= 0) continue;
            const cpuRate =
              m.cpuKind === 'performance'
                ? FLY_PRICING.performanceCpuRateUsdPerSec
                : FLY_PRICING.sharedCpuRateUsdPerSec;
            const ramGb = m.memoryMb / 1024;
            appUsd += (cpuRate * m.cpus + FLY_PRICING.ramRateUsdPerGbSec * ramGb) * seconds;
            billedMachines++;
          }
          if (appUsd > 0) perAppBreakdown.push(`${app}: $${appUsd.toFixed(2)}`);
          totalComputeUsd += appUsd;
        }
        lineItems.push({
          provider: 'fly',
          label: `Fly.io · ${fly.data.slug}`,
          amount: Math.round(totalComputeUsd * 100) / 100,
          currency: 'USD',
          confidence: 'estimated',
          period: periodLabel,
          basis: `${billedMachines} running machine${billedMachines === 1 ? '' : 's'} × Pay-as-you-go compute (24/7 upper bound; excl. stopped${
            perAppBreakdown.length > 0 ? `; ${perAppBreakdown.join(', ')}` : ''
          }) · no billing API — record the invoice as an actual`,
        });
      } else {
        lineItems.push({
          ...unknownLine('fly', 'Fly.io', periodLabel),
          basis: fly.ok
            ? `Org billing status: ${fly.data.billingStatus ?? 'unknown'}. No machines visible — see fly.io/dashboard/${fly.data.slug}/billing.`
            : 'Fly overview unavailable',
        });
      }

      // ----- Sentry: tier not surfaced by the projects API. -----
      lineItems.push({
        ...unknownLine('sentry', 'Sentry', periodLabel),
        basis:
          "Sentry's events-per-tier pricing isn't computable from the projects API alone — see sentry.io/settings/billing/.",
      });

      // Operator-entered actuals supersede the estimate for this month.
      const overrides: SpendOverride[] = overridesRes.ok ? overridesRes.data : [];
      const merged = applyOverrides(lineItems, overrides, period);

      const real = (l: SpendLineItem) => l.confidence === 'actual' || l.confidence === 'invoiced';
      const invoicedUsd = sumUsd(merged.filter(real));
      const estimatedUsd = sumUsd(merged.filter((l) => l.confidence === 'estimated'));

      return {
        period,
        totalUsd: round2(invoicedUsd + estimatedUsd),
        invoicedUsd: round2(invoicedUsd),
        estimatedUsd: round2(estimatedUsd),
        lineItems: merged.sort(
          (a, b) =>
            confidenceOrder(a.confidence) - confidenceOrder(b.confidence) || b.amount - a.amount
        ),
        recordedActuals: groupOverridesByPeriod(overrides),
        assumptions: [
          {
            label: 'Neon compute',
            rate: '$0.106/CU-hour (Launch) · $0.222/CU-hour (Scale) — no base fee, billed from hour 1',
            source: 'neon.com/pricing + consumption API',
          },
          {
            label: 'Neon storage / egress',
            rate: '$0.35/GiB-mo storage · $0.10/GiB egress past 100 GiB free',
            source: 'neon.com/pricing',
          },
          {
            label: 'Upstash',
            rate: 'Real charge via /redis/stats total_monthly_billing',
            source: 'Upstash developer API',
          },
          {
            label: 'Cloudflare',
            rate: 'Real invoiced amounts via /user/billing/history',
            source: 'Cloudflare billing API',
          },
          {
            label: 'Fly.io compute',
            rate: `$${FLY_PRICING.sharedCpuRateUsdPerSec}/vCPU-s shared · $${FLY_PRICING.performanceCpuRateUsdPerSec}/vCPU-s perf · $${FLY_PRICING.ramRateUsdPerGbSec}/GB-s RAM (no billing API)`,
            source: 'fly.io/docs/about/pricing/',
          },
          {
            label: 'Actuals',
            rate: 'Operator-entered off the real invoice — supersedes the estimate',
            source: 'Recorded actual bills (below)',
          },
        ],
      };
    })
  );
}

function unknownLine(
  provider: SpendLineItem['provider'],
  label: string,
  period: string,
  basis?: string
): SpendLineItem {
  return { provider, label, amount: 0, currency: 'USD', confidence: 'unknown', period, basis };
}

function toCloudflareLine(item: CfBillingHistoryItem): SpendLineItem {
  const amount = item.amount < 0 ? -item.amount : item.amount;
  return {
    provider: 'cloudflare',
    label: `Cloudflare · ${item.description}`,
    amount: round2(amount),
    currency: item.currency,
    confidence: 'invoiced',
    period: new Date(item.occurredAt).toISOString().slice(0, 10),
    basis: `${item.type} · ${item.action}${item.zone ? ` · ${item.zone.name}` : ''}`,
  };
}

function isCurrentMonth(item: CfBillingHistoryItem): boolean {
  const d = new Date(item.occurredAt);
  const now = new Date();
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
}

function periodKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function startOfUtcMonth(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Seconds a Fly machine has been "billed" this calendar month under our
 * upper-bound assumption (continuously running since max(month_start,
 * created_at)). Returns 0 for future-dated or unparseable timestamps.
 */
function secondsBilledThisMonth(createdAtIso: string, monthStart: Date, now: Date): number {
  const created = Date.parse(createdAtIso);
  if (!Number.isFinite(created)) return 0;
  const start = Math.max(created, monthStart.getTime());
  return Math.max(0, (now.getTime() - start) / 1000);
}

function sumUsd(items: SpendLineItem[]): number {
  // Skip non-USD line items in the rollup; they get rendered separately
  // so the total stays meaningful.
  return items
    .filter((i) => i.currency.toUpperCase() === 'USD')
    .reduce((acc, i) => acc + i.amount, 0);
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${n} B`;
}

// Re-exported for callers that build provider chips from the same map.
export { PROVIDER_DISPLAY };
