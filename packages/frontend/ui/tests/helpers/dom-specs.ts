import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Runs every `*.dom.tsx` spec in a CHILD `bun test` with a DOM preloaded
 * (SC-801).
 *
 * WHY A CHILD PROCESS, measured rather than preferred. Radix decides whether
 * `useLayoutEffect` is real or a no-op ONCE, when its module is first
 * imported — `globalThis?.document ? React.useLayoutEffect : () => {}` — and
 * seven copies of that shim are installed. A portal sets `mounted` in that
 * effect, so under a no-op it never mounts. `bun test` runs every file in one
 * process with one module cache, and the ui suite imports Radix in dozens of
 * static-markup files long before any DOM could be registered. Registering
 * happy-dom in a `beforeAll` instead gave `<div></div>` for all six sheets on
 * both branches — 13 of 17 red — with the hook read and the stub taken.
 *
 * So the DOM exists from the child's first line, and the main run never has
 * one: nothing can leak into the other ~12k tests, because the process they
 * run in never registered anything. The root `test` script is unchanged.
 *
 * WHY THE CHILD STARTS OUTSIDE THE REPO. `bunfig.toml` preloads the domain
 * test-preload into every `bun test` started here, and that installs the
 * suite guard, which claims the test database. Started from inside the main
 * run, the child found its own parent holding that database and refused — a
 * refusal about a database these specs never open. From a directory with no
 * `bunfig.toml`, the child loads only the two preloads named below. Module
 * resolution is per file, so nothing else changes.
 *
 * `*.dom.tsx` is not a name `bun test` collects on its own, which is what
 * keeps these out of the main run; it runs them when they are named, which is
 * what this does.
 */

const REPO_ROOT = resolve(import.meta.dir, '../../../../..');
const DOM_PRELOAD = join(import.meta.dir, 'dom-preload.ts');
/** The app's i18n preload, which the root `test` script also loads — the
 *  sheets render translated copy. */
const I18N_PRELOAD = join(REPO_ROOT, 'apps/frontend/app/tests/i18n-preload.ts');

export interface DomSpecFile {
  /** Repo-relative path. */
  file: string;
  tests: number;
  failures: number;
  skipped: number;
}

export interface DomSpecRun {
  exitCode: number;
  files: DomSpecFile[];
  output: string;
}

/** Every `*.dom.tsx` under a `tests/` directory, repo-relative and sorted. */
export function domSpecFiles(): string[] {
  const glob = new Bun.Glob('{apps,packages}/**/tests/**/*.dom.tsx');
  return [...glob.scanSync({ cwd: REPO_ROOT })]
    .filter((file) => !file.includes('node_modules'))
    .sort();
}

function attr(tag: string, name: string): number {
  const match = new RegExp(`\\b${name}="(\\d+)"`).exec(tag);
  return match ? Number(match[1]) : 0;
}

export function runDomSpecs(): DomSpecRun {
  const files = domSpecFiles();
  const cwd = mkdtempSync(join(tmpdir(), 'dom-specs-'));
  const report = join(cwd, 'junit.xml');
  const result = Bun.spawnSync(
    [
      'bun',
      'test',
      '--preload',
      DOM_PRELOAD,
      '--preload',
      I18N_PRELOAD,
      '--timeout',
      '30000',
      '--reporter=junit',
      `--reporter-outfile=${report}`,
      ...files.map((file) => join(REPO_ROOT, file)),
    ],
    { cwd, env: { ...process.env, NODE_ENV: 'test' }, stdout: 'pipe', stderr: 'pipe' }
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;

  // One `<testsuite>` per FILE at the top level, named by the path it was
  // given — absolute here — with its describe blocks nested inside.
  let xml = '';
  try {
    xml = readFileSync(report, 'utf8');
  } catch {
    // No report is a run that never got as far as writing one; `files` stays
    // empty and the caller's count assertion says so.
  }
  const tags = [...xml.matchAll(/<testsuite\b[^>]*>/g)].map((match) => match[0]);
  const perFile: DomSpecFile[] = [];
  for (const file of files) {
    const tag = tags.find((candidate) => candidate.includes(`name="${join(REPO_ROOT, file)}"`));
    if (tag) {
      perFile.push({
        file,
        tests: attr(tag, 'tests'),
        failures: attr(tag, 'failures') + attr(tag, 'errors'),
        skipped: attr(tag, 'skipped'),
      });
    }
  }
  return { exitCode: result.exitCode ?? 1, files: perFile, output };
}
