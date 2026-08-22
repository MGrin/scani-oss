// SC-533. `bun run test:e2e <path>` did not run that path.
//
// Playwright's `--project <project-name...>` is variadic, so the runner's own
// `--project chromium --project webkit` kept eating argv and read a trailing
// spec path as a third PROJECT NAME. Measured on @playwright/test 1.60.0:
//
//   playwright test --project chromium --project webkit tests/holdings/x.spec.ts
//   -> Error: Project(s) "tests/holdings/x.spec.ts" not found.
//
// so the run never happened. The ticket calls it silent; on this version it is
// loud and MISLEADING, which is a smaller defect wearing the same costume —
// the message names a project the caller never typed, and it arrives after a
// compose build, a stack boot and a health wait. A swallowed token that DOES
// name a real project is genuinely silent.
//
// Two halves, and they need different fixes. The projects this runner emits
// itself are now `--project=<name>`: the `=` ends the variadic and a trailing
// path arrives as the positional filter it is. A caller's OWN space-separated
// `--project` is forwarded verbatim and cannot be rewritten safely, so it is
// refused before the stack is touched.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { projectFlagEatsPath } from '../../apps/e2e/scripts/run.ts';

const RUNNER = new URL('../../apps/e2e/scripts/run.ts', import.meta.url);
const SOURCE = readFileSync(RUNNER, 'utf8');
const E2E_PACKAGE = JSON.parse(
  readFileSync(new URL('../../apps/e2e/package.json', import.meta.url), 'utf8')
) as { scripts: Record<string, string> };

describe('projectFlagEatsPath finds the argument the variadic will swallow', () => {
  test('a spec path after a space-separated --project is swallowed', () => {
    expect(
      projectFlagEatsPath(['--project', 'chromium', 'tests/holdings/add-manual-holding.spec.ts'])
    ).toBe('tests/holdings/add-manual-holding.spec.ts');
  });

  test('a bare directory is swallowed too', () => {
    expect(projectFlagEatsPath(['--project', 'chromium', 'tests/a11y'])).toBe('tests/a11y');
  });

  test('the equals form ends the variadic, so nothing is swallowed', () => {
    expect(
      projectFlagEatsPath(['--project=chromium', 'tests/holdings/add-manual-holding.spec.ts'])
    ).toBeNull();
  });

  /**
   * THE BENIGN CASE THAT SHARES THE SHAPE, and the reason the discriminator is
   * "looks like a path" rather than "is not a known project".
   *
   * `--project chromium webkit` is a caller legitimately naming two viewports
   * in one flag. Viewport names in `fixtures/devices.ts` carry no slash and no
   * extension, so they read as project names, which is what they are. A rule
   * keyed on "a second value after --project" would refuse this, and a guard
   * that fires on the legitimate case is a guard somebody deletes.
   */
  test('several project names in one flag are not a swallowed path', () => {
    expect(projectFlagEatsPath(['--project', 'chromium', 'webkit', 'iphone'])).toBeNull();
  });

  test('a flag ends the variadic before the path is reached', () => {
    expect(
      projectFlagEatsPath(['--project', 'chromium', '--headed', 'tests/holdings/x.spec.ts'])
    ).toBeNull();
  });

  test('-- ends option parsing outright', () => {
    expect(projectFlagEatsPath(['--project', 'chromium', '--', 'tests/holdings/x.spec.ts'])).toBe(
      null
    );
  });

  /**
   * THE TEST TO DELETE LAST. A guard that only ever fires is indistinguishable
   * from one that is broken, and the load-bearing evidence here is not that the
   * broken shape is caught — it is that the two shapes people actually run are
   * NOT caught. `test:e2e:a11y` puts its paths BEFORE its flags, where the
   * variadic never reaches them, and the plain suite passes no argv at all.
   */
  test('the shapes that are already correct are left alone', () => {
    expect(projectFlagEatsPath([])).toBeNull();
    expect(
      projectFlagEatsPath([
        'tests/a11y',
        'tests/smoke',
        '--project',
        'chromium',
        '--project',
        'iphone',
      ])
    ).toBeNull();
  });
});

describe('the runner never emits the space-separated form itself', () => {
  test('its own project arguments carry an equals sign', () => {
    expect(SOURCE).toContain('`--project=${project}`');
    // The literal that produced the bug. A `'--project'` argv element anywhere
    // in this file is the variadic re-opened.
    expect(SOURCE).not.toContain("['--project', project]");
  });

  test('the refusal names the equals form, which is the whole remedy', () => {
    const refusal = SOURCE.slice(SOURCE.indexOf('Refusing to run:'));
    expect(refusal.slice(0, 700)).toContain('--project=<name>');
  });

  /**
   * The check runs before `probeStack`, so a refusal costs nothing. Playwright
   * meets the same argv at the far end of a compose build and a health wait,
   * which is a ten-minute round trip to be told a project does not exist.
   */
  test('it refuses before the stack is touched', () => {
    const body = SOURCE.slice(SOURCE.indexOf('async function main()'));
    expect(body.indexOf('projectFlagEatsPath')).toBeLessThan(body.indexOf('probeStack()'));
  });
});

describe('the a11y gate keeps the form the runner can no longer fix for it', () => {
  /**
   * It passes its own `--project`, so `callerChoseProjects` short-circuits and
   * the runner adds nothing — its argv is whatever this script says. It was
   * safe by argument ORDER alone (paths first), which is one edit away from
   * being unsafe; the equals form makes it safe by construction and lets a
   * caller append a spec path to it.
   */
  test('test:e2e:a11y uses --project=', () => {
    const a11y = E2E_PACKAGE.scripts['test:e2e:a11y'] ?? '';
    expect(a11y).toContain('--project=chromium');
    expect(a11y).toContain('--project=iphone');
    expect(projectFlagEatsPath(a11y.split(' ').slice(2))).toBeNull();
  });
});
