#!/usr/bin/env bun
// Fixture for `read-only-session.test.ts`. Named `repair-*` on purpose: the
// policy in `@scani/db/read-only` keys off the entry point's file name, so
// this file IS the input under test. Run it with `--commit` and the same
// process opens read-write.
//
// It goes through `@scani/db/connection` rather than building a client of its
// own, because a test that assembles its own options proves something about
// the test.

import { client, isReadOnlySession } from '@scani/db/connection';

const result: Record<string, unknown> = { isReadOnlySession };

try {
  const rows = await client`show transaction_read_only`;
  result.sessionSaysReadOnly = rows[0]?.transaction_read_only === 'on';
} catch (error) {
  result.showFailed = (error as Error).message;
}

try {
  const read = await client`select 1 as one`;
  result.readWorks = read[0]?.one === 1;
} catch (error) {
  result.readFailed = (error as Error).message;
}

try {
  await client`create temp table sc422_probe (value int)`;
  await client`insert into sc422_probe (value) values (1)`;
  const [row] = await client`select count(*)::int as n from sc422_probe`;
  result.wrote = row?.n === 1;
} catch (error) {
  result.wrote = false;
  result.writeErrorCode = (error as { code?: string }).code;
}

console.log(`SC422_PROBE ${JSON.stringify(result)}`);
await client.end();
