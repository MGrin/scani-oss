import {
  countsTowardTotal,
  type HoldingWithDetails,
  holdingGainLoss,
  holdingsDebt,
  holdingsValue,
  holdingTypeTotals,
  isBaseCurrencyHolding,
} from '@scani/shared';

/**
 * Portfolio analysis and suggestions for the MCP tools (SC-1616). Every value
 * comes from `holdings.getWithDetails` through the same functions the Holdings
 * screen uses (`@scani/shared` holding figures), so a number stated here is
 * the number the app shows for that holding. Only the derived figures —
 * weights, drift, trade sizes — are new, and each is arithmetic on those.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Gross positive value: the base the Holdings allocation bar divides by. */
function grossAssets(holdings: readonly HoldingWithDetails[]): number {
  return holdingTypeTotals(holdings).reduce((sum, t) => sum + t.value, 0);
}

function positions(holdings: readonly HoldingWithDetails[]) {
  return holdings.filter(
    (h) => countsTowardTotal(h) && typeof h.value === 'number' && h.value > 0
  ) as (HoldingWithDetails & { value: number })[];
}

function priceOf(h: HoldingWithDetails): number | null {
  const v = h.price?.value;
  return v === null || v === undefined ? null : Number(v);
}

export function analysePortfolio(holdings: readonly HoldingWithDetails[], currency: string) {
  const gross = grossAssets(holdings);
  const held = positions(holdings).sort((a, b) => b.value - a.value);
  const weights = held.map((h) => (gross > 0 ? h.value / gross : 0));
  const cash = held.filter((h) => h.token.typeCode === 'fiat').reduce((sum, h) => sum + h.value, 0);
  return {
    currency,
    totalValue: holdingsValue(holdings),
    debt: holdingsDebt(holdings),
    grossAssets: gross,
    concentration: {
      positions: held.length,
      largestPct: round2((weights[0] ?? 0) * 100),
      top5Pct: round2(weights.slice(0, 5).reduce((s, w) => s + w, 0) * 100),
      // Herfindahl index on 0–10,000: under 1,500 is diversified, over 2,500 concentrated.
      hhi: Math.round(weights.reduce((s, w) => s + (w * 100) ** 2, 0)),
    },
    cashPct: round2(gross > 0 ? (cash / gross) * 100 : 0),
    byAssetType: holdingTypeTotals(holdings).map((t) => ({
      assetType: t.typeCode,
      value: t.value,
      pct: round2(gross > 0 ? (t.value / gross) * 100 : 0),
    })),
    holdings: held.map((h, i) => {
      const gain = holdingGainLoss(h, currency);
      return {
        id: h.id,
        symbol: h.token.symbol,
        name: h.label ?? h.token.name,
        assetType: h.token.typeCode,
        account: h.account.name,
        value: h.value,
        pct: round2((weights[i] ?? 0) * 100),
        costBasis: h.costBasis,
        unrealisedGain: gain?.absolute,
        unrealisedGainPct: gain ? round2(gain.percent) : undefined,
      };
    }),
  };
}

export interface RebalanceTarget {
  key: string;
  percent: number;
}

export class RebalanceInputError extends Error {}

/**
 * Drift from the user's targets and the trades that close it. Targets are by
 * asset type (`stock`, `crypto`, `fiat`, …) or by holding id, and must sum to
 * 100. Anything held but not targeted has a target of 0, so it is sold down.
 */
export function planRebalance(
  holdings: readonly HoldingWithDetails[],
  groupBy: 'asset_type' | 'holding',
  targets: readonly RebalanceTarget[],
  tolerancePct = 0
) {
  const sum = targets.reduce((s, t) => s + t.percent, 0);
  if (Math.abs(sum - 100) > 0.01) {
    throw new RebalanceInputError(`Targets sum to ${round2(sum)}%, not 100%`);
  }
  const held = positions(holdings);
  const gross = grossAssets(holdings);
  const current = new Map<string, { value: number; label: string; price: number | null }>();
  for (const h of held) {
    const key = groupBy === 'asset_type' ? h.token.typeCode : h.id;
    const existing = current.get(key);
    if (existing) existing.value += h.value;
    else
      current.set(key, {
        value: h.value,
        label: groupBy === 'asset_type' ? h.token.typeCode : h.token.symbol,
        price: groupBy === 'holding' ? priceOf(h) : null,
      });
  }
  if (groupBy === 'holding') {
    for (const t of targets) {
      if (!current.has(t.key)) {
        throw new RebalanceInputError(`No priced, counted holding with id ${t.key}`);
      }
    }
  }
  const keys = new Set([...current.keys(), ...targets.map((t) => t.key)]);
  const rows = [...keys].map((key) => {
    const now = current.get(key);
    const value = now?.value ?? 0;
    const targetPct = targets.find((t) => t.key === key)?.percent ?? 0;
    const currentPct = gross > 0 ? (value / gross) * 100 : 0;
    const drift = currentPct - targetPct;
    const trade = Math.abs(drift) > tolerancePct ? (targetPct / 100) * gross - value : 0;
    const price = now?.price ?? null;
    return {
      key,
      label: now?.label ?? key,
      value,
      currentPct: round2(currentPct),
      targetPct,
      driftPct: round2(drift),
      action: trade > 0 ? 'buy' : trade < 0 ? 'sell' : 'hold',
      tradeValue: round2(Math.abs(trade)),
      tradeQuantity: price && trade !== 0 ? Math.abs(trade) / price : undefined,
    };
  });
  rows.sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct));
  return { grossAssets: gross, groupBy, tolerancePct, rows };
}

export interface SuggestionOptions {
  maxPositionPct: number;
  maxCashPct: number;
  minLossToHarvest: number;
}

/**
 * Concrete buy/sell ideas from the figures above: trim any position over
 * `maxPositionPct`, harvest unrealised losses at least `minLossToHarvest`
 * (base currency), and put cash above `maxCashPct` to work, largest first.
 * Each idea carries the numbers it rests on.
 */
export function suggest(
  holdings: readonly HoldingWithDetails[],
  currency: string,
  opts: SuggestionOptions
) {
  const gross = grossAssets(holdings);
  const held = positions(holdings).sort((a, b) => b.value - a.value);
  const ideas: Record<string, unknown>[] = [];

  for (const h of held) {
    if (isBaseCurrencyHolding(h, currency) || h.token.typeCode === 'fiat') continue;
    const pct = gross > 0 ? (h.value / gross) * 100 : 0;
    if (pct <= opts.maxPositionPct) continue;
    const sellValue = h.value - (opts.maxPositionPct / 100) * gross;
    const price = priceOf(h);
    ideas.push({
      kind: 'trim',
      action: 'sell',
      holdingId: h.id,
      symbol: h.token.symbol,
      reason: `${h.token.symbol} is ${round2(pct)}% of the portfolio, over the ${opts.maxPositionPct}% cap`,
      value: h.value,
      pct: round2(pct),
      sellValue: round2(sellValue),
      sellQuantity: price ? sellValue / price : undefined,
    });
  }

  for (const h of held) {
    const gain = holdingGainLoss(h, currency);
    if (!gain || gain.absolute >= 0 || -gain.absolute < opts.minLossToHarvest) continue;
    ideas.push({
      kind: 'harvest_loss',
      action: 'sell',
      holdingId: h.id,
      symbol: h.token.symbol,
      reason: `${h.token.symbol} carries an unrealised loss of ${round2(-gain.absolute)} ${currency} (${round2(gain.percent)}%)`,
      value: h.value,
      costBasis: h.costBasis,
      unrealisedGain: gain.absolute,
      unrealisedGainPct: round2(gain.percent),
    });
  }

  const cash = held.filter((h) => h.token.typeCode === 'fiat');
  const cashValue = cash.reduce((s, h) => s + h.value, 0);
  const cashPct = gross > 0 ? (cashValue / gross) * 100 : 0;
  if (cashPct > opts.maxCashPct) {
    ideas.push({
      kind: 'deploy_cash',
      action: 'buy',
      reason: `Cash is ${round2(cashPct)}% of the portfolio, over the ${opts.maxCashPct}% cap`,
      cashValue,
      cashPct: round2(cashPct),
      investValue: round2(cashValue - (opts.maxCashPct / 100) * gross),
      from: cash.map((h) => ({ holdingId: h.id, symbol: h.token.symbol, value: h.value })),
    });
  }

  return { currency, grossAssets: gross, options: opts, ideas };
}
