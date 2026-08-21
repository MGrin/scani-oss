#!/usr/bin/env bun

/**
 * Seed the demo dataset into whatever `DATABASE_URL` points at (SC-465).
 *
 *   bun packages/business/domain/src/demo/cli.ts
 *   bun packages/business/domain/src/demo/cli.ts --anchor today
 *   bun packages/business/domain/src/demo/cli.ts --anchor 2026-08-21 --json
 *
 * `--anchor` moves the last day the dataset covers; everything else is dated
 * back from it. Determinism is per-anchor, not global: the same anchor gives
 * byte-identical figures on every run and a different anchor gives a
 * different, equally stable dataset. The default is fixed —
 * `packages/business/domain/src/demo/persona.ts` says which day and why.
 *
 * **A LIVE DEMO WANTS `--anchor today` AND THE DEFAULT WILL NOT DO.** Measured
 * on a running stack: with the fixed anchor the home hero reads the live
 * valuation (dated at the anchor, in the future) against a chart windowed off
 * the browser's clock, and prints "+47.1% vs 30d" over a month in which the
 * portfolio moved 7.2%; Money's Upcoming says "Nothing due in the next 90
 * days" because every occurrence before the anchor is settled. Re-seeded with
 * `--anchor today` the same stack reads "+2.0% vs 30d" and lists the next
 * three bills. The two modes serve different consumers and neither default is
 * right for both — see `persona.ts`.
 *
 * Idempotent: it deletes the demo user and its own price rows first, so a
 * re-run rebuilds rather than accumulating.
 */

import 'reflect-metadata';
import { Container } from 'typedi';
import { DemoDatasetSeeder } from './DemoDatasetSeeder';
import { buildDemoDataset } from './dataset';

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

const anchorFlag = flag('anchor');
const anchorDate = anchorFlag === 'today' ? new Date().toISOString().slice(0, 10) : anchorFlag;
const days = flag('days');
const asJson = argv.includes('--json');
/** Builds and prints the plan without touching the database. */
const dryRun = argv.includes('--dry-run');

if (anchorDate && !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate)) {
  console.error(`--anchor must be YYYY-MM-DD, got ${anchorDate}`);
  process.exit(2);
}

const options = {
  ...(anchorDate ? { anchorDate } : {}),
  ...(days ? { days: Number(days) } : {}),
};

if (dryRun) {
  const dataset = buildDemoDataset(options);
  const summary = {
    anchorDate: dataset.anchorDate,
    startDate: dataset.startDate,
    days: dataset.days,
    counts: {
      prices: dataset.prices.length,
      accounts: dataset.accounts.length,
      holdings: dataset.holdings.length,
      transactions: dataset.transactions.length,
      observations: dataset.observations.length,
      rollups: dataset.rollups.length,
      occurrences: dataset.occurrences.length,
    },
    closingNetWorth: dataset.rollups.find(
      (row) => row.scopeKind === 'user' && row.snapshotDate === dataset.anchorDate
    ),
    holdings: dataset.holdings.map((holding) => `${holding.symbol} ${holding.balance}`),
    // A negative low point anywhere is a chart that dips below zero, which is
    // the most obviously fake thing a portfolio can do — surfaced here rather
    // than found by looking at the rendered hero.
    lowestHoldingValue: [...dataset.holdings]
      .map((holding) => {
        const values = dataset.rollups
          .filter((row) => row.scopeKind === 'holding' && row.scopeRef === holding.key)
          .map((row) => Number(row.totalValue));
        return `${holding.key} min=${Math.min(...values).toFixed(2)}`;
      })
      .sort(),
  };
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

const summary = await Container.get(DemoDatasetSeeder).seed(options);

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`demo dataset seeded for user ${summary.userId}`);
  console.log(`  window  ${summary.startDate} .. ${summary.anchorDate}`);
  for (const [name, count] of Object.entries(summary.counts)) {
    console.log(`  ${name.padEnd(14)}${count}`);
  }
}

process.exit(0);
