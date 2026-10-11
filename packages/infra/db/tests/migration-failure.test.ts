import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrationFailureLines } from '../src/migration-failure';

/**
 * SC-1585. A refused migration printed `console.error('❌ Migration failed:',
 * error)`, and Bun's inspector put six lines of the compiled binary's minified
 * source before the one sentence a self-hoster needs.
 */

const refused = Object.assign(
  new Error(
    'check constraint "token_prices_price_positive_decimal_chk" of relation "token_prices" is violated by some row'
  ),
  {
    name: 'PostgresError',
    code: '23514',
    severity: 'ERROR',
    table_name: 'token_prices',
    constraint_name: 'token_prices_price_positive_decimal_chk',
  }
);

describe('migrationFailureLines', () => {
  it('a refused CHECK names the message, code, table and constraint on the line after the headline', () => {
    const [headline, detail, ...rest] = migrationFailureLines(refused, { debug: false });
    expect(headline).toBe('❌ Migration failed:');
    expect(detail).toBe(
      '   check constraint "token_prices_price_positive_decimal_chk" of relation "token_prices" is violated by some row' +
        ' · code 23514 · table token_prices · constraint token_prices_price_positive_decimal_chk'
    );
    expect(rest).toEqual([]);
  });

  it('prints no source excerpt and no stack unless asked', () => {
    const text = migrationFailureLines(refused, { debug: false }).join('\n');
    expect(text).not.toContain('at ');
    expect(migrationFailureLines(refused, { debug: true }).join('\n')).toContain(
      refused.stack ?? ''
    );
  });

  it('a plain error is its message alone, and a non-error is its string', () => {
    expect(
      migrationFailureLines(new Error('Migrations folder not found'), { debug: false })
    ).toEqual(['❌ Migration failed:', '   Migrations folder not found']);
    expect(migrationFailureLines('boom', { debug: false })).toEqual([
      '❌ Migration failed:',
      '   boom',
    ]);
  });

  it('migrate.ts prints through it, never the raw error', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'migrate.ts'), 'utf8');
    expect(source).not.toContain("console.error('❌ Migration failed:', error)");
    expect(source).toContain('migrationFailureLines(');
  });
});
