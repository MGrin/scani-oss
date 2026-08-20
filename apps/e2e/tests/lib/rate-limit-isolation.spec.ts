import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '../../fixtures/test';

const TESTS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = fileURLToPath(import.meta.url);

function specFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) specFiles(path, out);
    else if (path.endsWith('.spec.ts') && path !== SELF) out.push(path);
  }
  return out;
}

/**
 * The isolation in `fixtures/test.ts` only holds for specs that opt into it,
 * and both ways of opting out look completely ordinary in review: importing
 * `test` from `@playwright/test`, or building a context by hand. Either one
 * puts that spec back on the identity every other test shares, and the result
 * is not a failure in the offending spec — it is a 429 somewhere else, in a
 * different spec on every run. That is exactly the bug SC-489 was, and it
 * survived six CI runs and a controlled experiment before anyone could name
 * it. So it is checked here rather than left to review.
 */
test.describe('suite: rate-limit isolation', () => {
  test('every spec takes its identity from fixtures/test', () => {
    const offenders: string[] = [];

    for (const file of specFiles(TESTS_ROOT)) {
      const src = readFileSync(file, 'utf8');
      const where = relative(TESTS_ROOT, file);

      for (const match of src.matchAll(/import\s+([^;]*?)\s+from\s+'@playwright\/test';/g)) {
        const clause = match[1] ?? '';
        if (clause.startsWith('type ')) continue;
        const named = clause
          .replace(/[{}]/g, '')
          .split(',')
          .map((name) => name.trim());
        for (const name of named) {
          if (name === 'test' || name === 'expect') {
            offenders.push(`${where}: imports \`${name}\` from '@playwright/test'`);
          }
        }
      }

      if (src.includes('browser.newContext(') && !src.includes('isolatedContextOptions')) {
        offenders.push(`${where}: builds a context without \`isolatedContextOptions(testInfo)\``);
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
