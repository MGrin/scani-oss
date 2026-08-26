import { describe, expect, test } from 'bun:test';
import {
  assertNoConflictingOptionsParam,
  isDryRunOperatorScript,
  isOperatorScript,
  READ_ONLY_ENV_VAR,
  resolveReadOnlyIntent,
} from '../src/read-only';

const BUN = '/opt/homebrew/bin/bun';
const argv = (entry: string, ...rest: string[]) => [BUN, entry, ...rest];

describe('isDryRunOperatorScript', () => {
  test('a repair script with no write flag is a dry run', () => {
    expect(isDryRunOperatorScript(argv('scripts/repair-sc395-kraken-coverage-claims.ts'))).toBe(
      true
    );
  });

  // The negative control. Without it, a policy that returned `true`
  // unconditionally would pass every other test in this block.
  test('the same script with --commit is not', () => {
    expect(
      isDryRunOperatorScript(argv('scripts/repair-sc395-kraken-coverage-claims.ts', '--commit'))
    ).toBe(false);
  });

  // SC-646, and the whole reason this function was rewritten. Ten scripts gate
  // their writes on `--apply` and are named nothing in particular; under the
  // old name-keyed rule every one of them ran its DRY RUN on a writable
  // connection, which is the hole SC-422 closed for the scripts it could see.
  test('a destructive script that is not named repair-* is still a dry run', () => {
    expect(isDryRunOperatorScript(argv('scripts/rollup-portfolio-values.ts'))).toBe(true);
    expect(isDryRunOperatorScript(argv('scripts/repoint-ingested-transactions.ts'))).toBe(true);
  });

  test('...and the same script with --apply is not', () => {
    expect(isDryRunOperatorScript(argv('scripts/rollup-portfolio-values.ts', '--apply'))).toBe(
      false
    );
    expect(
      isDryRunOperatorScript(argv('scripts/repoint-ingested-transactions.ts', '--apply'))
    ).toBe(false);
  });

  // The catastrophic direction, and the one that matters most: 72 files outside
  // `scripts/` open this same connection — the api, the worker, the domain
  // package and 20 test files. A policy that reached any of them would boot the
  // services read-only.
  test('a service entry point is never forced read-only', () => {
    expect(isDryRunOperatorScript(argv('apps/backend/api/src/index.ts'))).toBe(false);
    expect(isDryRunOperatorScript(argv('apps/backend/worker/src/index.ts'))).toBe(false);
    expect(isDryRunOperatorScript(argv('packages/business/domain/src/index.ts'))).toBe(false);
  });

  // `bun test <file>` puts the TEST FILE in argv[1]. Repair scripts have tests
  // named after themselves; without this one file's path would open the whole
  // suite read-only and fail every test that writes.
  test('a test file does not trigger it, wherever it lives', () => {
    expect(
      isDryRunOperatorScript(argv('scripts/tests/repair-sc389-contradicted-ids.test.ts'))
    ).toBe(false);
    expect(isDryRunOperatorScript(argv('scripts/some-script.test.ts'))).toBe(false);
  });

  test('a bare interpreter with no entry point does not trigger it', () => {
    expect(isDryRunOperatorScript([BUN])).toBe(false);
  });

  describe('isOperatorScript — the scope, separately from the intent', () => {
    test('the DIRECTORY decides, and the file name does not', () => {
      // The inversion of the rule this replaces. Both of these were wrong
      // before: the first was read-write because of its name, the second
      // read-only for the same reason.
      expect(isOperatorScript(argv('/abs/path/to/scripts/anything-at-all.ts'))).toBe(true);
      expect(isOperatorScript(argv('/abs/path/to/lib/repair-anything.ts'))).toBe(false);
    });

    test('a nested path under scripts/ is not an entry point', () => {
      // `scripts/lib/*` is imported, never run. Only the immediate child.
      expect(isOperatorScript(argv('scripts/lib/repair-db.ts'))).toBe(false);
    });

    test('a directory merely starting with scripts does not count', () => {
      expect(isOperatorScript(argv('/abs/scripts-old/thing.ts'))).toBe(false);
    });

    test('a non-TypeScript entry point is not one', () => {
      expect(isOperatorScript(argv('scripts/publish-images-local.sh'))).toBe(false);
    });
  });
});

describe('resolveReadOnlyIntent', () => {
  const repair = argv('scripts/repair-sc395-kraken-coverage-claims.ts');
  const committing = argv('scripts/repair-sc395-kraken-coverage-claims.ts', '--commit');
  const applying = argv('scripts/repoint-ingested-transactions.ts', '--apply');

  test('falls through to the script policy when the env var is unset or blank', () => {
    expect(resolveReadOnlyIntent({ argv: repair, env: {} })).toBe(true);
    expect(resolveReadOnlyIntent({ argv: committing, env: {} })).toBe(false);
    expect(resolveReadOnlyIntent({ argv: repair, env: { [READ_ONLY_ENV_VAR]: '  ' } })).toBe(true);
  });

  test('an --apply script resolves the same way a --commit one does', () => {
    // The two spellings have to reach the same decision, or the ten scripts
    // that use the older one keep the SC-646 hole in a new place.
    expect(resolveReadOnlyIntent({ argv: applying, env: {} })).toBe(false);
    expect(
      resolveReadOnlyIntent({
        argv: argv('scripts/repoint-ingested-transactions.ts'),
        env: {},
      })
    ).toBe(true);
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
