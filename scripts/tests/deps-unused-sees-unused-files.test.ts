import { describe, expect, test } from 'bun:test';
import path from 'node:path';

/**
 * SC-553. `deps:unused` was `knip --dependencies`, which scopes knip to
 * dependency analysis and reports no unused FILES at all. It printed clean
 * before and after SC-527 deleted five genuinely dead files totalling 581
 * lines, and it is the check CLAUDE.md names as the instrument for dead code.
 *
 * The cost was measured twice in one week, both times a dead module mistaken
 * for its live twin: `packages/infra/queue/src/enqueue.ts`, which SC-523 filed
 * a hang against and a dated audit cited as evidence for a live property; and
 * `packages/business/shared/src/utils/request-cache.ts`, 323 lines mirroring
 * the live `@scani/domain/lib/request-cache`. A fix applied to the dead twin
 * measures green while the real defect stands.
 *
 * These assertions are about the check keeping its TEETH, which is a different
 * question from whether it currently passes. Each is a shape somebody will
 * reach for the next time knip reports something inconvenient, and each would
 * be silent: the run still succeeds, it just stops looking.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '../..');

type Manifest = { scripts: Record<string, string> };
type KnipConfig = {
  workspaces: Record<string, { entry?: string[]; project?: string[] }>;
  ignore?: string[];
  rules?: Record<string, string>;
};

const manifest = (await Bun.file(path.join(REPO_ROOT, 'package.json')).json()) as Manifest;
const knip = (await Bun.file(path.join(REPO_ROOT, 'knip.json')).json()) as KnipConfig;

describe('deps:unused can see an unused file', () => {
  test('the script asks knip for files, not dependencies alone', () => {
    const script = manifest.scripts['deps:unused'];
    expect(script).toContain('--include files');
    // `--dependencies` is a GROUP shorthand (dependencies, unlisted, binaries,
    // unresolved). Swapping it for `--include files,dependencies` reads like a
    // widening and is a narrowing — `unlisted` and `unresolved` stop being
    // reported, and nothing says so.
    expect(script).toContain('--dependencies');
  });

  test('`files` is not switched off in knip.json rules', () => {
    // `rules` beats the command line: with `"files": "off"` here, the
    // `--include files` above resolves to nothing and the run is green because
    // it looked at nothing.
    expect(knip.rules?.files ?? 'error').not.toBe('off');
  });

  test('`exports` and `types` are not switched back off (SC-558)', () => {
    // These were `"off"` until SC-558 triaged the 133 findings they produced
    // (71 exports + 62 types, re-measured on 8cf07a95e). None was a false
    // positive: none had a test-only consumer, none was reachable through a
    // workspace `exports` subpath, and every workspace here is
    // `private: true`, so "public API somebody outside might import" is an
    // empty category in this repo. 103 were live code carrying a redundant
    // `export` keyword; the rest were dead, including two whole modules that
    // duplicated a live twin (`utils/circuit-breaker.ts` against
    // `@scani/rate-limiter`, `utils/financial.ts` against `src/decimal.ts`) —
    // the SC-527 shape, kept alive only by their own tests.
    //
    // The pressure to switch these back is a red run on a symbol somebody
    // believes is public. That belief is checkable and was checked: switch it
    // back only after showing an importer knip cannot see, not because a
    // finding is inconvenient.
    expect(knip.rules?.exports ?? 'error').not.toBe('off');
    expect(knip.rules?.types ?? 'error').not.toBe('off');
  });

  test('the script asks knip for exports and types, not just files', () => {
    // Switching the rules on is only half of it, and the half that looks
    // sufficient. `--include` is a FILTER: `--include files` with
    // `"exports": "error"` reports no exports at all, and the run is green
    // having looked at nothing — the same vacuous pass the `files` rule above
    // guards against, reached from the opposite direction. Measured on
    // SC-558: `knip --dependencies --include files,exports,types` names an
    // injected unused export; drop `,exports,types` and it does not.
    const script = manifest.scripts['deps:unused'];
    expect(script).toContain('exports');
    expect(script).toContain('types');
  });

  test('nsExports / nsTypes / enumMembers stay documented, not silently absent', () => {
    // SC-558 left these three `off`. They report 0 on this tree, but a rule
    // enabled against an already-clean tree has never been seen to work, and
    // the probe written for them SHORT-CIRCUITED: an unused namespace is
    // reported by `exports` at the top level, so the member rules never ran.
    // Enabling them needs a namespace that is genuinely consumed with one
    // member that is not — build that probe first, then flip these and delete
    // this test. Do not flip them because the config looks half-finished.
    expect(knip.rules?.nsExports).toBe('off');
    expect(knip.rules?.nsTypes).toBe('off');
    expect(knip.rules?.enumMembers).toBe('off');
  });

  test('the root entry stays top-level, so scripts/lib stays covered', () => {
    // `scripts/*.ts` are hand-run operator entrypoints, invoked by path, that
    // no module imports, so knip cannot infer them and reported all 32 as
    // unused — including `sync-dockerhub-readme.ts`, which CLAUDE.md's own
    // before-pushing list runs. Declaring them is correcting the instrument.
    //
    // Widening this to `scripts/**/*.ts` would be the obvious response to a
    // future complaint about `scripts/lib/` or `scripts/tests/`, and it would
    // make every helper under them an entrypoint — permanently unable to be
    // reported dead. Those subdirectories are LIBRARIES, reached by import, and
    // they are the part of `scripts/` this check can still speak about.
    const entry = knip.workspaces['.']?.entry ?? [];
    expect(entry).toContain('scripts/*.ts');
    for (const pattern of entry) expect(pattern).not.toContain('**');
  });

  test('no workspace is silenced by an ignore that swallows source', () => {
    // `ignore` is the other way to make this check vacuous, and unlike `rules`
    // it leaves the issue type switched on, so the run still looks like it
    // measured something. `**/*.test.ts` is the one entry, and it is why knip
    // prints a configuration hint on every run.
    expect(knip.ignore).toEqual(['**/*.test.ts']);
  });
});
