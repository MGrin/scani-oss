/**
 * SC-728 — the census must see both call forms, and a URL must name something.
 *
 * TWO KINDS OF ASSERTION HERE, WITH DELIBERATELY DIFFERENT REDDENING INPUTS.
 *
 * The CAPABILITY arms run against fixtures, never against the repo. Their
 * reddening input is the scanner regressing, and only that — so migrating the
 * crash reporter to the typed client, or adding a nested router, or deleting a
 * procedure, cannot turn any of them red. That matters: an assertion pinning
 * "these five procedures are URL-only" would go red on somebody doing the right
 * thing, which is the shape that gets a correct fix reverted (SC-729, SC-740).
 *
 * The GUARD arm runs against the real tree, and its reddening input is a
 * mistake: a hand-built URL naming a procedure no router defines. That is the
 * hole the type checker cannot close — deleting or renaming the procedure
 * behind `apps/frontend/app/src/lib/report-client-error.ts:31` leaves that file
 * compiling perfectly and 404-ing in production — and it is the protection the
 * five URL-only procedures actually need.
 *
 * EVERY PROCEDURE NAME BELOW IS FICTIONAL, AND THAT IS A REQUIREMENT RATHER
 * THAN A STYLE. This file is inside the population its own census scans, so a
 * real procedure path written here makes it a CALLER of that procedure. It has
 * happened three times in this one module — URL literals in a docblock, URL
 * literals in these fixtures, and typed examples in a docblock — and the third
 * moved two procedures out of the URL-only set, which is the over-reporting
 * direction that under-reports dead code silently. The last `describe` block
 * pins it so a fourth cannot ship.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  census,
  FIXTURE_URLS,
  findTypedRefs,
  findUrlRefs,
  isDefinitionSite,
  resolve,
  scanPopulation,
} from '../lib/api-procedure-callers';

/**
 * The URL prefix, ASSEMBLED rather than written — and this is the whole reason
 * the fixtures below read the way they do.
 *
 * Every fixture has to EVALUATE to a real hand-built URL while this file's own
 * source contains none, because the census scans tracked files and this file is
 * one of them. Written literally, the fixtures made the test file a caller of
 * seven procedures that do not exist — and the guard reported them, correctly,
 * with nothing to distinguish its own fixtures from a real finding.
 *
 * It passed before that only because the file was still UNTRACKED, so
 * `git ls-files` could not see it. A new file's first honest run is its first
 * run after `git add`.
 *
 * Same remedy, and the same reason, as `check-oss-internal-refs.ts`: a rule
 * spelled out as a plain literal is itself the thing the rule forbids.
 */
const T = ['', 'trpc', ''].join('/');

const PROCS = new Set([
  'alpha.report',
  'beta.list',
  'beta.listPending',
  'beta.rules.create',
  'gamma.everything',
  'delta.getWithDetails',
]);
const isProc = (p: string) => PROCS.has(p);

describe('the two call forms are seen by different halves of the scanner', () => {
  const urlSource = `const url = \`\${apiBase}${T}alpha.report\`;`;
  const typedSource = 'const q = trpc.delta.getWithDetails.useQuery();';

  test('a hand-built URL is found by the URL scanner', () => {
    expect(findUrlRefs(urlSource, 'f.ts').map((r) => r.path)).toEqual(['alpha.report']);
  });

  /**
   * The ticket's whole claim, as a capability rather than as a fact about
   * today's tree: no accessor list reaches a string built at runtime.
   */
  test('and is invisible to the typed scanner — no accessor list can reach it', () => {
    expect(findTypedRefs(urlSource, 'f.ts', isProc)).toEqual([]);
  });

  test('a typed call is found by the typed scanner', () => {
    expect(findTypedRefs(typedSource, 'f.ts', isProc).map((r) => r.path)).toEqual([
      'delta.getWithDetails',
    ]);
  });

  test('and is invisible to the URL scanner', () => {
    expect(findUrlRefs(typedSource, 'f.ts')).toEqual([]);
  });

  /**
   * A backticked line is CODE. Treating any line containing a backtick as
   * prose hid all five URL-only callers when SC-728 was measured, because
   * every hand-built URL in this repo is a template literal.
   */
  test('a template literal is scanned, not skipped as prose', () => {
    const src = [
      `// a comment mentioning ${T}beta.list`,
      `await page.request.post(\`\${API_BASE_URL}${T}beta.list\`, {});`,
    ].join('\n');
    expect(findUrlRefs(src, 'f.ts').map((r) => r.line)).toEqual([1, 2]);
  });
});

describe('nothing counts segments, so neither arity bug is reachable', () => {
  /**
   * Five live procedures read as dead in this tool's own first run because a
   * procedure was assumed to be `<router>.<proc>`.
   */
  test('a nested router of three segments is found', () => {
    const src = 'const create = trpc.beta.rules.create.useMutation({});';
    expect(findTypedRefs(src, 'f.ts', isProc).map((r) => r.path)).toEqual(['beta.rules.create']);
  });

  /** Two more, from an accessor that is itself two words. */
  test('a two-word accessor is found', () => {
    const src = 'const data = await utils.client.gamma.everything.query();';
    expect(findTypedRefs(src, 'f.ts', isProc).map((r) => r.path)).toEqual(['gamma.everything']);
  });

  /**
   * The prefix collision SC-728 reports: matching `<router>.<proc>` as a plain
   * substring makes `beta.list` match `beta.listPending`,
   * so a genuinely uncalled procedure reads as called. Extract-then-intersect
   * cannot produce it — the identifier is taken whole.
   */
  test('a longer sibling is NOT reported as its shorter prefix', () => {
    const src = 'trpc.beta.listPending.useQuery();';
    const found = findTypedRefs(src, 'f.ts', isProc).map((r) => r.path);
    expect(found).toEqual(['beta.listPending']);
    expect(found).not.toContain('beta.list');
  });

  /** Must-be-FOUND control for the arm above: the shorter one IS findable. */
  test('control — the shorter sibling is found when it is what is written', () => {
    expect(findTypedRefs('trpc.beta.list.useQuery();', 'f.ts', isProc)).toHaveLength(1);
  });

  /**
   * A URL path is anchored: one ending `<a>.<b>.<c>` addresses that procedure
   * and must not be quietly resolved to `<a>.<b>`, or a caller left behind by a
   * rename resolves to the wrong thing and the guard below never fires.
   */
  test('a URL chain is reported whole, never as a prefix of itself', () => {
    expect(findUrlRefs(`\`\${b}${T}beta.rules.create\``, 'f.ts')[0]?.path).toBe(
      'beta.rules.create'
    );
  });

  /**
   * Zero chains in the tree span a line break today (measured 2026-08-28 over
   * all 1755 files scanned in the mirror, 2072 privately), so the tree cannot
   * exercise this and a green from it would
   * otherwise mean nothing. The fixture is what makes that zero a measurement.
   */
  test('a chain wrapped across a line is still found', () => {
    const src = 'const q = trpc.delta\n  .getWithDetails.useQuery();';
    expect(findTypedRefs(src, 'f.ts', isProc).map((r) => r.path)).toEqual(['delta.getWithDetails']);
  });
});

describe('a procedure declaring its own OpenAPI path is not a caller of itself', () => {
  test('the two services own router trees are definition sites', () => {
    expect(isDefinitionSite('apps/backend/data-provider/src/presentation/routers/pricing.ts')).toBe(
      true
    );
    expect(isDefinitionSite('apps/backend/api/src/presentation/router.ts')).toBe(true);
  });

  /** Control: an ordinary caller must NOT be excluded as a definition. */
  test('control — a real call site is not', () => {
    expect(isDefinitionSite('apps/e2e/tests/groups/create-and-assign.spec.ts')).toBe(false);
    expect(isDefinitionSite('apps/frontend/app/src/lib/report-client-error.ts')).toBe(false);
  });
});

describe('a name on both routers resolves to BOTH, not to a guess', () => {
  const api = new Set(['tokens.search', 'alpha.report']);
  const dp = new Set(['tokens.search', 'pricing.convertRate']);

  test('tokens.search exists on both services and the string cannot say which', () => {
    expect(resolve('tokens.search', api, dp)).toBe('both');
  });

  test('the unambiguous cases still resolve', () => {
    expect(resolve('alpha.report', api, dp)).toBe('api');
    expect(resolve('pricing.convertRate', api, dp)).toBe('data-provider');
  });

  test('and a name on neither is unresolved rather than assigned', () => {
    expect(resolve('nope.nope', api, dp)).toBe('unresolved');
  });
});

describe('the census reports the two forms separately', () => {
  const apiProcedures = ['alpha.report', 'delta.getWithDetails', 'vendors.get'];
  const files = [
    ['a.ts', `const url = \`\${b}${T}alpha.report\`;`],
    ['b.tsx', 'trpc.delta.getWithDetails.useQuery();'],
    ['c.ts', `const u = \`\${b}${T}delta.getWithDetails\`;`],
  ] as const;

  const result = census({ apiProcedures, dataProviderProcedures: [], files });

  test('URL-only is the set a typed-client sweep would have called dead', () => {
    expect(result.urlOnly).toEqual(['alpha.report']);
  });

  test('a procedure reached both ways is not URL-only', () => {
    expect(result.reachedByUrl).toEqual(['alpha.report', 'delta.getWithDetails']);
    expect(result.urlOnly).not.toContain('delta.getWithDetails');
  });

  test('and no-caller is reported rather than folded into either', () => {
    expect(result.noCaller).toEqual(['vendors.get']);
  });

  /**
   * The must-be-FOUND control for the live-tree guard below. Without it,
   * `unresolvedUrls: 0` on the real repo is satisfied equally by "every URL
   * names a real procedure" and by "the resolver never fires".
   */
  test('control — a URL naming no procedure surfaces as unresolved', () => {
    const withTypo = census({
      apiProcedures,
      dataProviderProcedures: [],
      files: [...files, ['d.ts', `const u = \`\${b}${T}alpha.reprot\`;`]] as const,
    });
    expect(withTypo.unresolvedUrls.map((r) => r.path)).toEqual(['alpha.reprot']);
  });

  test('a definition site contributes no caller', () => {
    const dpFiles = [
      ['apps/backend/data-provider/src/presentation/routers/pricing.ts', `path: '${T}x.y',`],
    ] as const;
    const r = census({ apiProcedures: ['x.y'], dataProviderProcedures: [], files: dpFiles });
    expect(r.filesScanned).toBe(0);
    expect(r.noCaller).toEqual(['x.y']);
  });
});

/**
 * SC-755 — the population, which is the half that fails silently.
 *
 * The census used to build its file list from six pathspec globs, one per
 * root, each of the shape `<root>` + `/**` + `/*.ts`. In a git pathspec `**`
 * between two slashes requires at least one intermediate directory, so the
 * `scripts` one reached `scripts/lib/x.ts` and never `scripts/x.ts` — 0 of
 * the files directly under `scripts/`, this census's own CLI among them.
 *
 * NOTHING WENT RED, and nothing could have. The remaining globs contributed a
 * healthy total, the only floor asked about that total, and every count the
 * census printed was a correct answer about a set that was missing a sixth of
 * the tree. A wrong predicate gets argued with by the first careful reader; a
 * wrong population gets ratified by every one of them.
 *
 * So the arms below are on the POPULATION, not on the scanners:
 *
 *   must-be-FOUND   a file directly under `scripts/` is in it   (RED before the fix)
 *   control         a file one level deeper still is           (green either way,
 *                                                               so a fix that
 *                                                               emptied the list
 *                                                               cannot pass)
 *   control         a `.tsx` survives the extension filter
 *   must-be-ABSENT  a tracked non-TypeScript path is not in it
 *   must-be-FOUND   a root git cannot read REFUSES rather than returning []
 *   control         the real root does not refuse
 */
describe('the scan population', () => {
  const repoRoot = new URL('../..', import.meta.url).pathname;
  const found = scanPopulation(repoRoot);
  const paths = found.kind === 'population' ? found.paths : [];

  test('control — a population was built at all, so the absences below are not vacuous', () => {
    expect(found.kind).toBe('population');
    expect(paths.length).toBeGreaterThan(1000);
  });

  /**
   * The bug itself. `scripts/api-procedure-callers.ts` sits directly under
   * `scripts/`, which is exactly what the old glob could not reach.
   */
  test('a file directly under scripts/ is in the population', () => {
    expect(paths).toContain('scripts/api-procedure-callers.ts');
  });

  /**
   * The control for it. This one was always reachable, so it stays green
   * either side of the fix — which is what stops a "fix" that returns an empty
   * or a wrong list from satisfying the arm above by accident.
   */
  test('control — a file one directory deeper is too', () => {
    expect(paths).toContain('scripts/lib/api-procedure-callers.ts');
  });

  test('control — .tsx survives the extension filter', () => {
    expect(paths.some((p) => p.endsWith('.tsx'))).toBe(true);
  });

  test('a tracked non-TypeScript path is not in the population', () => {
    expect(paths).not.toContain('package.json');
    expect(paths.filter((p) => !p.endsWith('.ts') && !p.endsWith('.tsx'))).toEqual([]);
  });

  /**
   * The general remedy, and the reason this ticket is worth more than its own
   * fix: a file list that comes back empty must REFUSE. An empty array is the
   * one shape a scanner consumes without complaint, and `PASS · 0 findings`
   * over nothing is indistinguishable from a clean tree.
   */
  test('a root git cannot read refuses rather than returning an empty list', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'api-procedure-callers-'));
    const refused = scanPopulation(outside);
    expect(refused.kind).toBe('refused');
    expect(refused.kind === 'refused' ? refused.why : '').toContain('git ls-files exited');
  });
});

describe('the live tree', () => {
  const run = Bun.spawnSync(['bun', 'scripts/api-procedure-callers.ts', '--json'], {
    cwd: new URL('../..', import.meta.url).pathname,
  });
  const stdout = run.stdout.toString();

  test('the census runs and its stdout is a document, not a log', () => {
    expect(run.exitCode).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  const result = run.exitCode === 0 ? JSON.parse(stdout) : null;

  /**
   * The floor. "No procedure is reached by a URL" and "nothing was searched"
   * render identically, and only the first is a fact about this repo.
   */
  test('it examined a population rather than reporting over an empty one', () => {
    expect(result.apiProcedureCount).toBeGreaterThan(100);
    expect(result.dataProviderProcedureCount).toBeGreaterThan(20);
    expect(result.filesScanned).toBeGreaterThan(1000);
    expect(result.reachedByUrl.length).toBeGreaterThan(0);
  });

  /**
   * THE GUARD. A hand-built URL has no compile-time link to the procedure it
   * names, so a rename or a deletion leaves the caller compiling and broken.
   * This is the one assertion here whose reddening input is a real mistake.
   *
   * If it fires: the fix is to repair the URL, not to add the path to
   * `FIXTURE_URLS` — that list is for strings which deliberately name nothing,
   * and adding a real caller to it retires the only check that would ever have
   * caught it again.
   */
  test('every hand-built URL in tracked source names a procedure that exists', () => {
    const unresolved = result.unresolvedUrls as Array<{ file: string; line: number; path: string }>;
    expect(unresolved.map((r) => `${r.file}:${r.line} ${r.path}`)).toEqual([]);
  });

  /** A declaration for a string that is gone stops guarding anything. */
  test('no declared fixture has outlived the source it describes', () => {
    const seen = result.fixturesSeen as Array<{ file: string; path: string }>;
    const stale = FIXTURE_URLS.filter(
      (f) => !seen.some((s) => s.file === f.file && s.path === f.path)
    );
    expect(stale.map((f) => `${f.file} ${f.path}`)).toEqual([]);
  });
});

/**
 * The instrument must not appear in its own results.
 *
 * This module documents itself with examples, and the census deliberately does
 * NOT treat a comment as prose — a heuristic that did hid all five URL-only
 * callers when SC-728 was measured. Those two facts together mean a real
 * procedure path written anywhere in these three files, in either call form,
 * makes the census a caller of it.
 *
 * It has happened three times here. The first two were URL literals and were
 * loud, because the paths they named did not exist and the unresolved-URL guard
 * reported them. THE THIRD WAS SILENT AND IS WHY THIS BLOCK EXISTS: a docblock
 * illustrating the typed form with two REAL procedures resolved perfectly, so
 * nothing was unresolved and nothing complained — it simply moved those two out
 * of the URL-only set. Caught only by comparing two trees.
 *
 * So the guard is on the property, not on the instances: the census's own
 * source names no real procedure in either form, ever.
 */
describe('the census does not appear in its own results', () => {
  const OWN = [
    'scripts/lib/api-procedure-callers.ts',
    'scripts/api-procedure-callers.ts',
    'scripts/tests/api-procedure-callers.test.ts',
  ] as const;

  const run = Bun.spawnSync(['bun', 'scripts/api-procedure-callers.ts', '--json'], {
    cwd: new URL('../..', import.meta.url).pathname,
  });
  const parsed = run.exitCode === 0 ? JSON.parse(run.stdout.toString()) : null;
  // BOTH routers. A data-provider path named here is inert today — the census
  // counts api hits only — but the claim this block makes is "no real procedure
  // in either form", and a guard narrower than its own sentence is how the
  // blind spot comes back the moment someone widens the census.
  const real: string[] = parsed ? [...parsed.apiProcedures, ...parsed.dataProviderProcedures] : [];
  const isReal = (p: string) => real.includes(p);

  /**
   * Must-be-FOUND control, and it is not optional here: every assertion below
   * is an ABSENCE, and an absence over an empty procedure set is vacuously
   * true. If the census failed to enumerate, `real` is `[]` and all three
   * pass while measuring nothing.
   */
  test('control — the real procedure set was actually loaded', () => {
    expect(real.length).toBeGreaterThan(100);
  });

  test('no typed reference to a real procedure', async () => {
    const hits: string[] = [];
    for (const f of OWN) {
      const src = await Bun.file(new URL(`../../${f}`, import.meta.url).pathname).text();
      for (const r of findTypedRefs(src, f, isReal)) hits.push(`${r.file}:${r.line} ${r.path}`);
    }
    expect(hits).toEqual([]);
  });

  test('no hand-built URL naming a real procedure', async () => {
    const hits: string[] = [];
    for (const f of OWN) {
      const src = await Bun.file(new URL(`../../${f}`, import.meta.url).pathname).text();
      for (const r of findUrlRefs(src, f)) {
        if (isReal(r.path)) hits.push(`${r.file}:${r.line} ${r.path}`);
      }
    }
    expect(hits).toEqual([]);
  });

  /**
   * Second must-be-FOUND control. The two arms above scan real files and would
   * read clean if the scanners themselves went blind, which is the same failure
   * they exist to catch. This proves both can still fire on the exact shapes.
   */
  test('control — both scanners still fire on a real procedure name', () => {
    const victim = real[0] as string;
    expect(findTypedRefs(`trpc.${victim}.useQuery();`, 'f.ts', isReal)).toHaveLength(1);
    expect(findUrlRefs(`\`\${b}${T}${victim}\``, 'f.ts')).toHaveLength(1);
  });
});
