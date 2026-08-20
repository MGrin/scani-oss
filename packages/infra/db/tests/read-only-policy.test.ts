import { describe, expect, test } from 'bun:test';
import {
  assertNoConflictingOptionsParam,
  isDryRunRepairScript,
  READ_ONLY_ENV_VAR,
  resolveReadOnlyIntent,
} from '../src/read-only';

const BUN = '/opt/homebrew/bin/bun';
const argv = (entry: string, ...rest: string[]) => [BUN, entry, ...rest];

describe('isDryRunRepairScript', () => {
  test('a repair script with no write flag is a dry run', () => {
    expect(isDryRunRepairScript(argv('scripts/repair-sc395-kraken-coverage-claims.ts'))).toBe(true);
  });

  // The negative control. Without it, a policy that returned `true`
  // unconditionally would pass every other test in this block.
  test('the same script with --commit is not', () => {
    expect(
      isDryRunRepairScript(argv('scripts/repair-sc395-kraken-coverage-claims.ts', '--commit'))
    ).toBe(false);
  });

  test('a script that is not a repair script is never forced read-only', () => {
    expect(isDryRunRepairScript(argv('scripts/rollup-portfolio-values.ts'))).toBe(false);
    expect(isDryRunRepairScript(argv('apps/backend/api/src/index.ts'))).toBe(false);
  });

  // `bun test <file>` puts the TEST FILE in argv[1], and repair scripts have
  // tests named after themselves. Without this exclusion one file's name would
  // open the whole suite read-only and fail every test that writes.
  test('a test file named after a repair script does not trigger it', () => {
    expect(isDryRunRepairScript(argv('scripts/tests/repair-sc389-contradicted-ids.test.ts'))).toBe(
      false
    );
  });

  test('a bare interpreter with no entry point does not trigger it', () => {
    expect(isDryRunRepairScript([BUN])).toBe(false);
  });

  test('the directory does not matter, the file name does', () => {
    expect(isDryRunRepairScript(argv('/abs/path/to/scripts/repair-anything.ts'))).toBe(true);
    expect(isDryRunRepairScript(argv('/abs/path/repairs-things.ts'))).toBe(false);
  });
});

describe('resolveReadOnlyIntent', () => {
  const repair = argv('scripts/repair-sc395-kraken-coverage-claims.ts');
  const committing = argv('scripts/repair-sc395-kraken-coverage-claims.ts', '--commit');

  test('falls through to the script policy when the env var is unset or blank', () => {
    expect(resolveReadOnlyIntent({ argv: repair, env: {} })).toBe(true);
    expect(resolveReadOnlyIntent({ argv: committing, env: {} })).toBe(false);
    expect(resolveReadOnlyIntent({ argv: repair, env: { [READ_ONLY_ENV_VAR]: '  ' } })).toBe(true);
  });

  test('the env var overrides the policy in both directions', () => {
    expect(resolveReadOnlyIntent({ argv: committing, env: { [READ_ONLY_ENV_VAR]: '1' } })).toBe(
      true
    );
    expect(resolveReadOnlyIntent({ argv: repair, env: { [READ_ONLY_ENV_VAR]: '0' } })).toBe(false);
    for (const on of ['true', 'YES', 'On']) {
      expect(resolveReadOnlyIntent({ argv: [BUN], env: { [READ_ONLY_ENV_VAR]: on } })).toBe(true);
    }
    for (const off of ['false', 'NO', 'Off']) {
      expect(resolveReadOnlyIntent({ argv: repair, env: { [READ_ONLY_ENV_VAR]: off } })).toBe(
        false
      );
    }
  });

  // A typo read as "off" is this ticket's failure mode one layer up: a guard
  // someone believed they had applied, silently absent.
  test('a value it cannot read throws rather than assuming read-write', () => {
    expect(() =>
      resolveReadOnlyIntent({ argv: repair, env: { [READ_ONLY_ENV_VAR]: 'yess' } })
    ).toThrow(/neither on nor off/);
  });
});

describe('assertNoConflictingOptionsParam', () => {
  // postgres.js spreads URL query params OVER `connection`, so an `options`
  // param in the URL replaces the read-only startup option with no error.
  test('refuses a URL carrying its own options param', () => {
    expect(() =>
      assertNoConflictingOptionsParam('postgres://u:p@h:5432/db?options=-c%20work_mem%3D64MB')
    ).toThrow(/silently replace the read-only startup option/);
  });

  test('accepts a URL without one, and ignores a URL it cannot parse', () => {
    expect(() =>
      assertNoConflictingOptionsParam('postgres://u:p@h:5432/db?sslmode=require')
    ).not.toThrow();
    expect(() => assertNoConflictingOptionsParam('not a url at all')).not.toThrow();
  });
});
