import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';

/**
 * SC-230 widened `makeToken`'s symbol from `randomUUID().slice(0, 4)` — a space
 * of 65,536 — to the full uuid, because 127 call sites shared the one crypto
 * token type and therefore one namespace under
 * `tokens (symbol, type_id, COALESCE(market_segment,''))`.
 *
 * It fixed the factory and left eight direct-insert sites on the old pattern
 * (found 2026-08-16 while measuring SC-227). Those were less dangerous than the
 * factory — each file creates its OWN token type, so `type_id` isolates them
 * and a collision could only happen between two symbols inside one file — but
 * "less dangerous" is not a property anything checked, and it is not the reason
 * they survived. They survived because nothing looked.
 *
 * This asserts the pattern is gone rather than that the collision is unlikely.
 * A birthday collision among N symbols in one file is N^2/131072, which is
 * small, non-zero, and exactly the kind of number that produces a bug report
 * every few months with a different test named each time.
 */

const ROOT = new URL('../..', import.meta.url).pathname;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git') continue;
    const p = `${dir}/${entry}`;
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/**
 * Comments are stripped before scanning. `factories-extra.ts` quotes the old
 * pattern verbatim to explain why it was replaced, and a guard that counts its
 * own rationale as a violation gets deleted rather than obeyed — the same trap
 * that made three separate greps report the opposite of the truth on 2026-08-16.
 */
function executableSource(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('token symbols in tests use the full uuid', () => {
  const files = walk(`${ROOT}/domain`).filter(
    (f) => /\.(test|spec)\.ts$/.test(f) || f.includes('/test/')
  );

  test('no test seeds a token symbol from a 4-character uuid slice', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = executableSource(require('node:fs').readFileSync(file, 'utf8'));
      if (/slice\(0,\s*4\)\.toUpperCase\(\)/.test(code)) {
        offenders.push(file.replace(ROOT, ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the scan actually reached the test tree', () => {
    // Non-vacuous: if the walk stops finding files, the assertion above passes
    // by scanning nothing — the failure mode this whole class of guard has.
    expect(files.length).toBeGreaterThan(20);
  });

  test('the comment explaining the old pattern is not itself a violation', () => {
    const factory = require('node:fs').readFileSync(
      `${ROOT}/domain/test/helpers/factories-extra.ts`,
      'utf8'
    );
    // The rationale must survive: it is the only record of why the full uuid
    // is load-bearing, and the guard must tolerate it.
    expect(factory).toContain('slice(0, 4)');
    expect(executableSource(factory)).not.toMatch(/slice\(0,\s*4\)\.toUpperCase\(\)/);
  });
});
