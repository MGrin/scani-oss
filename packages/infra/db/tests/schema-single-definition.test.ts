import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { Glob } from 'bun';
import { PgTable } from 'drizzle-orm/pg-core';
import * as barrel from '../src/index';
import * as modular from '../src/schema/index';

/**
 * SC-278. `src/schema.ts` (a monolith) and `src/schema/` (per-entity files)
 * both defined the same 36 physical tables. Nothing compared them, and by
 * 2026-08-16 eight had already diverged — 25 columns, 5 indexes and the
 * primary key of `portfolio_value_daily` existed only in the modular copy.
 *
 * The duplication was invisible because of module resolution, not carelessness:
 * `export * from './schema'` prefers the FILE `schema.ts` over the DIRECTORY
 * `schema/`, so `@scani/db` re-exported the stale monolith while
 * `@scani/db/schema` exported the current one. The same identifier imported
 * from the two entrypoints was two different objects, and the 11 tables that
 * only ever existed in `schema/` were unreachable from `@scani/db` — which is
 * the real reason one of them once needed a hand-written re-export whose
 * comment blamed Bun's resolver for "dropping the symbol". It was the shadow,
 * and that comment invited the workaround to grow a line per table.
 *
 * (The table is deliberately not named here: this file is OSS-eligible, and
 * naming a private-only one puts private content upstream. `oss-classify`
 * caught exactly that on the first gate of this PR.)
 *
 * Both hazards are structural and will return the moment someone adds a file
 * next to a directory of the same name, so both are asserted here rather than
 * left to review.
 */
describe('drizzle schema has exactly one definition per table', () => {
  const srcDir = path.join(import.meta.dir, '..', 'src');

  const definitions = (async () => {
    const found = new Map<string, string[]>();
    for await (const rel of new Glob('**/*.ts').scan(srcDir)) {
      const source = await Bun.file(path.join(srcDir, rel)).text();
      for (const match of source.matchAll(/pgTable\(\s*'([^']+)'/g)) {
        const name = match[1];
        if (!name) continue;
        const declaredIn = found.get(name) ?? [];
        declaredIn.push(rel);
        found.set(name, declaredIn);
      }
    }
    return found;
  })();

  test('the scan finds tables at all, so none of this can pass vacuously', async () => {
    const found = await definitions;
    expect(found.size).toBeGreaterThan(40);
  });

  test('no physical table name is declared by two files', async () => {
    const offenders = [...(await definitions).entries()]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `  '${name}' declared in: ${files.join(', ')}`);

    expect(
      offenders,
      `Two files declare the same physical table. Drizzle will happily build both,\n` +
        `they will drift, and the error surfaces at whichever cast happens to bridge\n` +
        `them — in a different workspace, naming neither file. Keep one definition:\n${offenders.join('\n')}`
    ).toEqual([]);
  });
});

describe('@scani/db and @scani/db/schema export the same tables', () => {
  const tablesOf = (module: Record<string, unknown>) =>
    Object.entries(module).filter(([, value]) => value instanceof PgTable) as [string, PgTable][];

  test('the modular barrel exports tables, so none of this can pass vacuously', () => {
    expect(tablesOf(modular).length).toBeGreaterThan(40);
  });

  test('every table reachable from `@scani/db/schema` is reachable from `@scani/db`', () => {
    const missing = tablesOf(modular)
      .map(([name]) => name)
      .filter((name) => !(name in barrel));

    expect(
      missing,
      `These tables exist in src/schema/ but are not re-exported by src/index.ts.\n` +
        `A file shadowing the schema/ directory is the usual cause — check that\n` +
        `src/schema.ts has not come back: ${missing.join(', ')}`
    ).toEqual([]);
  });

  test('a table imported from either entrypoint is the identical object', () => {
    const divergent = tablesOf(modular)
      .filter(
        ([name, table]) => name in barrel && (barrel as Record<string, unknown>)[name] !== table
      )
      .map(([name]) => name);

    expect(
      divergent,
      `\`import { x } from '@scani/db'\` and \`from '@scani/db/schema'\` returned\n` +
        `different objects for: ${divergent.join(', ')}.\n` +
        `Two definitions of one table are live at once; they will drift.`
    ).toEqual([]);
  });
});
