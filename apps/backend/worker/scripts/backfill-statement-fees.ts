#!/usr/bin/env bun

//
// One-shot repair for SC-159: put back the statement fees that imports before
// PR #744 dropped.
//
//   bun scripts/backfill-statement-fees.ts                 # dry run, writes nothing
//   bun scripts/backfill-statement-fees.ts --apply         # write
//   bun scripts/backfill-statement-fees.ts --apply --user <uuid>
//
// Dry run is the default because this writes ledger rows and re-derives
// opening balances. Running it twice is safe — see the use case's header for
// the three independent reasons — but a first look should still cost nothing.
//
// Lives here rather than at the repo root because it needs `@scani/domain`'s
// DI container, which the worker already boots.
//

import 'reflect-metadata';
import '@scani/domain/repositories';
import '@scani/domain/services';
import { BackfillStatementFeesUseCase } from '@scani/domain/use-cases';
import { Container } from 'typedi';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const userIndex = args.indexOf('--user');
const userId = userIndex >= 0 ? args[userIndex + 1] : undefined;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const summary = await Container.get(BackfillStatementFeesUseCase).execute({
  dryRun: !apply,
  userId,
});

console.log(apply ? '--- applied ---' : '--- dry run, nothing written ---');
console.log(`statement rows scanned            ${summary.scanned}`);
console.log(`of those, still stating a fee     ${summary.feesFound}`);
console.log(`fee rows written                  ${summary.feesWritten}`);
console.log(`total fee magnitude (mixed ccy)   ${summary.totalFeeMagnitude}`);
console.log(`holdings touched                  ${summary.holdingsTouched}`);
console.log(`openings re-synthesized           ${summary.openingsResynthesized}`);

process.exit(0);
