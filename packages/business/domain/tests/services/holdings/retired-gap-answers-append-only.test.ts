/**
 * SC-1453. `retired_gap_answers` is the only copy of the rows a person retired,
 * and the operator's condition for Retire was that the copy never expires. So
 * no code under `packages/` or `apps/` may delete from it. The account's own
 * data deletion is the one exception, and it reaches the table through the
 * manifest's generic delete rather than by name.
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import * as schema from '@scani/db/schema';
import { USER_DATA_TABLE_DISPOSITIONS } from '../../../src/use-cases/user-data-deletion-manifest';

const ROOT = resolve(import.meta.dir, '../../../../../..');
const SELF = resolve(import.meta.dir, 'retired-gap-answers-append-only.test.ts');

const DELETES = [
  /\.delete\(\s*(?:schema\.)?retiredGapAnswers\b/,
  /\bDELETE\s+FROM\s+"?retired_gap_answers\b/i,
  /\bTRUNCATE\s+(?:TABLE\s+)?"?retired_gap_answers\b/i,
];

function deletes(text: string): boolean {
  return DELETES.some((pattern) => pattern.test(text));
}

async function sourceFiles(): Promise<string[]> {
  const found: string[] = [];
  for (const top of ['packages', 'apps']) {
    const glob = new Bun.Glob(`${top}/**/*.{ts,tsx,sql}`);
    for await (const path of glob.scan({ cwd: ROOT, onlyFiles: true })) {
      if (path.includes('/node_modules/') || path.includes('/dist/')) continue;
      found.push(resolve(ROOT, path));
    }
  }
  return found.filter((path) => path !== SELF);
}

describe('retired_gap_answers is append-only', () => {
  test('the patterns catch each way of deleting from it', () => {
    expect(deletes('await tx.delete(schema.retiredGapAnswers).where(x)')).toBe(true);
    expect(deletes('await db.delete(retiredGapAnswers)')).toBe(true);
    expect(deletes('DELETE FROM retired_gap_answers WHERE user_id = $1')).toBe(true);
    expect(deletes('truncate table "retired_gap_answers"')).toBe(true);
    expect(deletes('await tx.delete(schema.holdingTransactions)')).toBe(false);
  });

  test('no file under packages/ or apps/ deletes from it', async () => {
    const files = await sourceFiles();
    let mentions = 0;
    const offenders: string[] = [];
    for (const path of files) {
      const text = await Bun.file(path).text();
      if (!text.includes('retiredGapAnswers') && !text.includes('retired_gap_answers')) continue;
      mentions += 1;
      if (deletes(text)) offenders.push(path.slice(ROOT.length + 1));
    }
    // The control: the schema, its migration and the service all name the
    // table, so a scan that found none of them read nothing.
    expect(mentions).toBeGreaterThanOrEqual(3);
    expect(offenders).toEqual([]);
  });

  test("the account's own data deletion is the one way out", () => {
    const entry = USER_DATA_TABLE_DISPOSITIONS.find(
      (disposition) => disposition.table === schema.retiredGapAnswers
    );
    expect(entry?.kind).toBe('delete');
  });
});
