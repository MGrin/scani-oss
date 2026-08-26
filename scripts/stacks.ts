#!/usr/bin/env bun
/**
 * Report every compose project on this machine and whether a checkout is still
 * behind it (SC-530). `bun run dev:stacks`.
 *
 * A REPORTER, NOT A REAPER. It stops nothing, removes nothing and selects
 * nothing to remove — see the header of `lib/stack-census.ts` for why that is
 * a decision rather than an unfinished feature, and `tests/stack-census.test.ts`
 * for the guard that keeps it one.
 *
 * EXIT 0 EVEN WITH ORPHANS. An orphaned stack is not this command's failure,
 * and a non-zero exit would make it a gate — which would put a machine-wide
 * fact in the way of an unrelated task, and get the command switched off.
 * Exit 1 is reserved for docker not answering, because then the report is
 * about nothing.
 */

import { dirname, resolve } from 'node:path';
import { censusFromMachine, formatCensus } from './lib/stack-census';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

async function main(): Promise<void> {
  const census = censusFromMachine(REPO_ROOT, true);
  process.stdout.write(formatCensus(census));
  process.exit(census.blind === null ? 0 : 1);
}

if (import.meta.main) await main();
