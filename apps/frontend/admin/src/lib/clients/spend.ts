import { cached } from '../cache';
import { type Result, tryCatch } from '../result';
import { type CfBillingHistoryItem, getBillingHistory } from './cloudflare';
import { getFlyOverview } from './fly';
import { getNeonProjects } from './neon';
import { getUpstashDatabases, getUpstashStats } from './upstash';

/**
 * Monthly-spend rollup across every infra provider Scani pays for.
 *
 * The page is honest about what's known vs. what's modelled — every
 * line item carries a `confidence` chip:
 *
 *   - `invoiced`  → pulled from a billing-history endpoint (real money,
 *                   real dates). Cloudflare exposes this; nothing else
 *                   does at the moment.
 *   - `estimated` → computed from the current period's usage counters
 *                   times public-tier pricing. Off from reality by
 *                   whatever discounts / overages aren't captured in the
 *                   constants below.
 *   - `unknown`   → the upstream API doesn't expose enough to compute a
 *                   number. Operator must check the vendor dashboard.
 *
 * Public pricing as of 2026-Q2. When a vendor changes their list price,
 * update the `PRICING` block. The page surfaces the same numbers on a
 * "Pricing assumptions" card so the operator can sanity-check them.
 */

export type SpendConfidence = 'invoiced' | 'estimated' | 'unknown';

export type SpendProvider = 'cloudflare' | 'fly' | 'neon' | 'upstash' | 'sentry';

export interface SpendLineItem {
  provider: SpendProvider;
  /** Display name (e.g. "Cloudflare R2 storage", "Neon · scani Launch plan"). */
  label: string;
  /** Amount in USD. Cloudflare history items in other currencies are normalized to USD if listed as USD, otherwise we keep the original currency for transparency. */
  amount: number;
  currency: string;
  confidence: SpendConfidence;
  /** Human period descriptor ("month-to-date 2026-05", "last invoice 2026-04-15", etc.). */
  period: string;
  /** Optional: how the number was computed, surfaced in a tooltip column. */
  basis?: string;
}

export interface SpendSummary {
  /** Sum of all `estimated` + `invoiced` line items in USD. */
  totalUsd: number;
  invoicedUsd: number;
  estimatedUsd: number;
  lineItems: SpendLineItem[];
  /** Pricing constants surfaced for the "Assumptions" card. */
  assumptions: Array<{
    label: string;
    rate: string;
    source: string;
  }>;
}

// --- Public pricing as of 2026-Q2. Update both this block and the
//     `assumptions` array below in lockstep. ---

const PRICING = {
  neonComputeHourUsd: 0.16, // $0.16 per CPU-hour beyond plan-included
  neonLaunchMonthlyUsd: 19, // Launch plan base fee
  neonScaleMonthlyUsd: 69, // Scale plan base fee
  neonLaunchIncludedComputeHours: 300, // Launch tier monthly inclusion
  neonScaleIncludedComputeHours: 750, // Scale tier monthly inclusion
  // Upstash "Pay-as-you-go" Redis: $0.2 per 100K commands, $0.25/GB-month.
  upstashPer100kCommandsUsd: 0.2,
  upstashStorageGbMonthUsd: 0.25,
} as const;

export async function getSpendSummary(): Promise<Result<SpendSummary>> {
  return tryCatch(() =>
    cached('spend:summary', 300, async () => {
      const [cfHistory, neon, upstash, fly] = await Promise.all([
        getBillingHistory(),
        getNeonProjects(),
        getUpstashDatabases(),
        getFlyOverview(),
      ]);

      const lineItems: SpendLineItem[] = [];
      const periodLabel = monthPeriodLabel(new Date());

      // ----- Cloudflare: real invoiced amounts -----
      if (cfHistory.ok) {
        for (const item of cfHistory.data.filter(isCurrentMonth)) {
          lineItems.push(toCloudflareLine(item));
        }
      } else {
        lineItems.push({
          provider: 'cloudflare',
          label: 'Cloudflare (billing API)',
          amount: 0,
          currency: 'USD',
          confidence: 'unknown',
          period: periodLabel,
          basis: cfHistory.error,
        });
      }

      // ----- Neon: estimate from compute-hours + plan -----
      if (neon.ok) {
        for (const project of neon.data) {
          const planTier = project.plan.toLowerCase();
          const plan = neonPlanModel(planTier);
          const overageHours = Math.max(0, project.computeHours - plan.includedHours);
          const overageUsd = Math.round(overageHours * PRICING.neonComputeHourUsd * 100) / 100;
          const total = Math.round((plan.baseUsd + overageUsd) * 100) / 100;
          lineItems.push({
            provider: 'neon',
            label: `Neon · ${project.name} (${project.plan})`,
            amount: total,
            currency: 'USD',
            confidence: plan.baseUsd > 0 || overageUsd > 0 ? 'estimated' : 'invoiced',
            period: periodLabel,
            basis:
              plan.baseUsd === 0 && overageUsd === 0
                ? 'Free tier — no charges'
                : `${plan.baseUsd > 0 ? `$${plan.baseUsd.toFixed(2)} base + ` : ''}${project.computeHours.toFixed(2)} CPU-hours${overageHours > 0 ? ` (${overageHours.toFixed(2)} over ${plan.includedHours} included)` : ''}`,
          });
        }
      } else {
        lineItems.push({
          provider: 'neon',
          label: 'Neon (projects API)',
          amount: 0,
          currency: 'USD',
          confidence: 'unknown',
          period: periodLabel,
          basis: neon.error,
        });
      }

      // ----- Upstash: estimate from monthly commands × $0.20 / 100K -----
      //
      // Counters live on `/redis/stats/<id>` (`getUpstashStats`), NOT
      // on the list endpoint — historical versions of this estimate
      // read `db.totalCommands` from the list response, which Upstash
      // doesn't populate, so the line item was always $0. Fan out one
      // stats call per database; same cache layer dedupes it with the
      // Overview's UpstashCard and the dedicated /platform/upstash page.
      if (upstash.ok) {
        const usageResults = await Promise.all(
          upstash.data.map(async (db) => ({ db, usage: await getUpstashStats(db.id) }))
        );
        for (const { db, usage } of usageResults) {
          if (!usage.ok) {
            lineItems.push({
              provider: 'upstash',
              label: `Upstash · ${db.name}`,
              amount: 0,
              currency: 'USD',
              confidence: 'unknown',
              period: periodLabel,
              basis: usage.error,
            });
            continue;
          }
          const commands = usage.data.monthlyRequests;
          // Upstash Pay-as-you-go: $0.20 per 100K commands. We don't
          // currently surface storage-GB in the admin client, so we
          // omit it from the estimate and call that out in the basis.
          const commandsUsd =
            Math.round((commands / 100_000) * PRICING.upstashPer100kCommandsUsd * 100) / 100;
          lineItems.push({
            provider: 'upstash',
            label: `Upstash · ${db.name}`,
            amount: commandsUsd,
            currency: 'USD',
            confidence: 'estimated',
            period: periodLabel,
            basis: `${formatCommandCount(commands)} cmds × $${PRICING.upstashPer100kCommandsUsd.toFixed(2)}/100K (storage not modelled)`,
          });
        }
      } else {
        lineItems.push({
          provider: 'upstash',
          label: 'Upstash (databases API)',
          amount: 0,
          currency: 'USD',
          confidence: 'unknown',
          period: periodLabel,
          basis: upstash.error,
        });
      }

      // ----- Fly: status only — no per-month invoice via public API -----
      lineItems.push({
        provider: 'fly',
        label: 'Fly.io',
        amount: 0,
        currency: 'USD',
        confidence: 'unknown',
        period: periodLabel,
        basis: fly.ok
          ? `Org billing status: ${fly.data.billingStatus ?? 'unknown'}. Fly's public API doesn't expose invoice totals — see fly.io/dashboard/${fly.data.slug}/billing.`
          : 'Fly overview unavailable',
      });

      // ----- Sentry: events count varies wildly month-over-month and the
      // tier is not surfaced by the project API. Mark unknown for now. -----
      lineItems.push({
        provider: 'sentry',
        label: 'Sentry',
        amount: 0,
        currency: 'USD',
        confidence: 'unknown',
        period: periodLabel,
        basis:
          "Sentry's events-per-tier pricing isn't computable from the projects API alone — see sentry.io/settings/billing/.",
      });

      const invoicedUsd = sumUsd(lineItems.filter((l) => l.confidence === 'invoiced'));
      const estimatedUsd = sumUsd(lineItems.filter((l) => l.confidence === 'estimated'));
      const totalUsd = invoicedUsd + estimatedUsd;

      return {
        totalUsd: Math.round(totalUsd * 100) / 100,
        invoicedUsd: Math.round(invoicedUsd * 100) / 100,
        estimatedUsd: Math.round(estimatedUsd * 100) / 100,
        lineItems: lineItems.sort(
          (a, b) =>
            confidenceOrder(a.confidence) - confidenceOrder(b.confidence) || b.amount - a.amount
        ),
        assumptions: [
          {
            label: 'Neon compute',
            rate: `$${PRICING.neonComputeHourUsd}/CPU-hour beyond plan inclusion`,
            source: 'neon.tech/pricing (Launch/Scale)',
          },
          {
            label: 'Neon Launch / Scale base',
            rate: `$${PRICING.neonLaunchMonthlyUsd} / $${PRICING.neonScaleMonthlyUsd} per month`,
            source: 'neon.tech/pricing',
          },
          {
            label: 'Upstash commands',
            rate: `$${PRICING.upstashPer100kCommandsUsd}/100K (Pay-as-you-go Redis)`,
            source: 'upstash.com/pricing',
          },
          {
            label: 'Cloudflare',
            rate: 'Real invoiced amounts via /user/billing/history',
            source: 'Cloudflare billing API',
          },
          {
            label: 'Fly + Sentry',
            rate: 'Not modelled — public APIs do not expose totals',
            source: 'Operator checks vendor dashboards directly',
          },
        ],
      };
    })
  );
}

function neonPlanModel(plan: string): { baseUsd: number; includedHours: number } {
  if (plan.includes('launch'))
    return {
      baseUsd: PRICING.neonLaunchMonthlyUsd,
      includedHours: PRICING.neonLaunchIncludedComputeHours,
    };
  if (plan.includes('scale'))
    return {
      baseUsd: PRICING.neonScaleMonthlyUsd,
      includedHours: PRICING.neonScaleIncludedComputeHours,
    };
  return { baseUsd: 0, includedHours: 0 };
}

function toCloudflareLine(item: CfBillingHistoryItem): SpendLineItem {
  const amount = item.amount < 0 ? -item.amount : item.amount;
  return {
    provider: 'cloudflare',
    label: `Cloudflare · ${item.description}`,
    amount: Math.round(amount * 100) / 100,
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

function monthPeriodLabel(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `month-to-date ${year}-${month}`;
}

function sumUsd(items: SpendLineItem[]): number {
  // Skip non-USD line items in the rollup; they get rendered separately
  // so the total stays meaningful.
  return items
    .filter((i) => i.currency.toUpperCase() === 'USD')
    .reduce((acc, i) => acc + i.amount, 0);
}

function confidenceOrder(c: SpendConfidence): number {
  return c === 'invoiced' ? 0 : c === 'estimated' ? 1 : 2;
}

function formatCommandCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}
