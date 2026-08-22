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
    // it looked at nothing. `exports` and `types` ARE off, deliberately — 79
    // unused exports and 70 unused types are a triage, not this check.
    expect(knip.rules?.files ?? 'error').not.toBe('off');
  });

  test('the root entry stays top-level, so scripts/lib stays covered', () => {
    // `scripts/*.ts` are hand-run operator entrypoints (`bun scripts/x.ts`) that
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
