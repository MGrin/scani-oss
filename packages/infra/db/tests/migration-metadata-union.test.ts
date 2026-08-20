/**
 * SC-408 — a migration may not union `tokens.provider_metadata` across rows.
 *
 * This is the guard for the writer nobody could name. SC-403 found two
 * production token rows carrying an `etherscan` contract beside a
 * `solana.mint`, explained the SECOND write (the weekly backfill deriving a
 * `defillama.coin` from that contract), and shipped `mergeIdentityDeltas` to
 * refuse it. The FIRST write — how the `etherscan` namespace reached a row
 * whose identity is a Solana mint — was unattributed, and every TypeScript
 * candidate was checked and cleared: `findOrCreateByIdentity` returns an
 * existing row untouched, `resolveIdentity` synthesizes
 * `evm:<chainId>:<contract>` so an EVM partial lands on its own row, and no
 * enricher emits an `etherscan` namespace.
 *
 * It was `0007_merge_chain_spread_crypto.sql`:
 *
 *     SELECT provider_metadata INTO merged_metadata FROM tokens WHERE id = rec.canonical_id;
 *     UPDATE tokens
 *       SET provider_metadata = COALESCE(merged_metadata, '{}'::jsonb) || COALESCE(rec.dup_meta, '{}'::jsonb)
 *
 * A top-level jsonb concat, right side winning, with no question asked about
 * which namespace is authoritative — and a canonical chosen as
 * `ORDER BY (market_segment IS NULL) DESC, created_at ASC`, which is the
 * Solana row every time, because a Solana identity has no market segment. The
 * commit's own dry-run reports it: "USDT/MATIC/WETH/BONK/TRUMP: each merged
 * to 1 row."
 *
 * `mergeIdentityDeltas` cannot see any of that. It is a TypeScript function
 * and this was SQL, which is exactly why the write looked unattributable from
 * inside the code — so the guard for it has to live where migrations are read.
 *
 * See `docs/technical/2026-08-19_sc408-the-migration-that-unioned-namespaces.md`.
 */

import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { readMigrationFiles } from '../src/migration-files';

const MIGRATIONS = path.join(import.meta.dir, '..', 'src', 'migrations');

/**
 * The one migration that does this. Frozen rather than fixed: it is applied in
 * production and a legacy migration keeps the name and the bytes it was
 * applied under (`migration-files.test.ts`), so the entry is a record of a
 * known write, not permission for another.
 */
const KNOWN_UNIONS: ReadonlySet<string> = new Set(['0007_merge_chain_spread_crypto']);

/**
 * Statements that SET `provider_metadata` to an expression containing a jsonb
 * concat.
 *
 * Deliberately narrow. It does not flag reading `provider_metadata`, indexing
 * it, or setting it to a literal — `0047` and `0000` do the first two and are
 * fine. What it flags is the shape that combines one row's namespaces into
 * another's, because that is the operation with no way to ask which one is
 * right.
 */
export function findMetadataUnions(sql: string): string[] {
  const hits: string[] = [];
  // `SET provider_metadata = …` up to the next clause boundary. `[\s\S]` so a
  // union split across lines — which is how it was actually written — is not
  // invisible to a line-anchored `.`.
  const pattern = /set\s+provider_metadata\s*=\s*([\s\S]*?)(?:,\s*\w+\s*=|\s+where\b|;)/gi;
  for (const match of sql.matchAll(pattern)) {
    const expression = match[1] ?? '';
    if (expression.includes('||')) hits.push(expression.replace(/\s+/g, ' ').trim());
  }
  return hits;
}

describe('a migration may not union token provider_metadata (SC-408)', () => {
  const files = readMigrationFiles(MIGRATIONS);

  test('the folder is non-empty, so none of this passes vacuously', () => {
    expect(files.length).toBeGreaterThan(40);
  });

  // THE NEGATIVE CONTROL. The detector runs over ~50 files that mostly do not
  // mention `provider_metadata` at all, so "no new unions" is a sentence a
  // broken regex says just as readily as a working one.
  test('the detector finds the union it was written for', () => {
    const zero = files.find((f) => f.tag === '0007_merge_chain_spread_crypto');
    expect(zero).toBeDefined();
    expect(findMetadataUnions(zero?.sql ?? '')).toHaveLength(1);
  });

  test('the detector finds a union written on one line', () => {
    expect(
      findMetadataUnions('UPDATE tokens SET provider_metadata = a || b WHERE id = 1;')
    ).toHaveLength(1);
  });

  test('the detector finds a union split across lines, as 0007 wrote it', () => {
    expect(
      findMetadataUnions(
        `UPDATE tokens
           SET provider_metadata = COALESCE(m, '{}'::jsonb) || COALESCE(d, '{}'::jsonb),
               updated_at = NOW()
           WHERE id = x;`
      )
    ).toHaveLength(1);
  });

  test('the detector does not flag a plain assignment', () => {
    expect(
      findMetadataUnions("UPDATE tokens SET provider_metadata = '{}'::jsonb WHERE id = 1;")
    ).toEqual([]);
  });

  test('the detector does not flag reading the column', () => {
    expect(
      findMetadataUnions("SELECT provider_metadata -> 'etherscan' FROM tokens WHERE id = 1;")
    ).toEqual([]);
  });

  test('no migration outside the known one unions provider_metadata', () => {
    const offenders = files
      .filter((file) => !KNOWN_UNIONS.has(file.tag))
      .flatMap((file) => findMetadataUnions(file.sql).map((hit) => `${file.tag}: ${hit}`));
    expect(offenders).toEqual([]);
  });

  test('the known union is still there, so the allowlist is not stale', () => {
    // An entry naming a file that no longer does this would quietly widen the
    // guard the next time someone reused the name.
    const stale = [...KNOWN_UNIONS].filter((tag) => {
      const file = files.find((f) => f.tag === tag);
      return !file || findMetadataUnions(file.sql).length === 0;
    });
    expect(stale).toEqual([]);
  });
});
