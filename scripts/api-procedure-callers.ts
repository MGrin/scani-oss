#!/usr/bin/env bun
/**
 * Census of who calls each tRPC procedure — both call forms (SC-728).
 *
 *   bun scripts/api-procedure-callers.ts           the report
 *   bun scripts/api-procedure-callers.ts --json    machine-readable, for the guard test
 *
 * The mechanism, the two traps it makes unreachable, and the full list of what
 * it cannot see are in `scripts/lib/api-procedure-callers.ts`. Read that before
 * quoting a number from this. The short version:
 *
 *   - the procedure list comes from the RUNTIME router, so it cannot miss a
 *     procedure whose file name and mount key differ (`routers/client-errors.ts`
 *     mounts as `clientErrors`) or one built by a factory (`tokens`);
 *   - both call forms are scanned, because a typed-client sweep is blind to
 *     five api procedures and one of them is the production crash reporter;
 *   - the forms are reported SEPARATELY, never summed, because over-reporting
 *     callers under-reports dead code silently.
 *
 * `no caller in this tree` IS NOT A DELETION LIST (SC-680). An endpoint with no
 * caller here is either dead surface or an external contract we cannot see, and
 * those want opposite treatment; deleting one of the second kind is an outage
 * for somebody we did not know we had. It is a question to take to mgrin.
 */

// typedi reads decorator metadata at class-init time, and every router pulls in
// `@Service()` classes. Without this the first factory-built router throws
// `Reflect.getMetadata is not a function` — the same reason the test preload
// loads it before anything else.
import 'reflect-metadata';
import { type Census, census, FIXTURE_URLS, scanPopulation } from './lib/api-procedure-callers';

/**
 * Both router modules read `DATABASE_URL` at import time and construct a
 * postgres.js client. This is a static-analysis tool: it issues no query, and
 * postgres.js opens no socket until one is issued — measured by importing both
 * routers with the URL below pointing at a closed port, which returns in about
 * a second rather than timing out.
 *
 * It is forced rather than defaulted. A census run by somebody whose shell
 * happens to hold a production `DATABASE_URL` should not be relying on "nothing
 * in this import graph queries" being true of every module either router will
 * ever pull in. Unreachable beats handled.
 */
process.env.DATABASE_URL = 'postgres://api-procedure-callers:unused@127.0.0.1:1/none';

/**
 * The routers' boot logging goes to STDOUT, not stderr — measured: `--json`
 * emitted `🐘 Connected to PostgreSQL database` above the document and
 * `JSON.parse` died on it. This tool's stdout is a document, so the log lines
 * are silenced here rather than filtered out by whoever reads it.
 *
 * Nothing a reader needs is hidden. The session this opens is read-only under
 * SC-422's policy — no `--commit` in argv — so a module that did try to write
 * would be refused by Postgres, and there is no Postgres here to refuse it.
 */
process.env.LOG_LEVEL = 'silent';

// Dynamic because the two assignments above have to happen FIRST and ES imports
// are hoisted. `scripts/` is outside the top-level-imports-only rule, which
// covers `apps/backend/` and `packages/business|infra|clients` (CLAUDE.md).
const { appRouter: apiRouter } = await import('../apps/backend/api/src/presentation/router');
const { appRouter: dpRouter } = await import(
  '../apps/backend/data-provider/src/presentation/router'
);

function proceduresOf(router: unknown): string[] {
  const def = (router as { _def?: { procedures?: Record<string, unknown> } })._def;
  return Object.keys(def?.procedures ?? {}).sort();
}

const apiProcedures = proceduresOf(apiRouter);
const dataProviderProcedures = proceduresOf(dpRouter);

/**
 * A zero on either axis is the one reading this tool must never present as a
 * result: "no procedure is reached by a URL" and "no file was searched" render
 * identically, and only the first is a fact about the repo.
 */
const floorFailures: string[] = [];
if (apiProcedures.length < 100) {
  floorFailures.push(
    `only ${apiProcedures.length} api procedure(s) enumerated — the router did not load, or its shape changed`
  );
}
if (dataProviderProcedures.length < 20) {
  floorFailures.push(
    `only ${dataProviderProcedures.length} data-provider procedure(s) enumerated — same`
  );
}
if (floorFailures.length > 0) {
  process.stderr.write(
    `api-procedure-callers: REFUSED · NOTHING MEASURED\n${floorFailures.map((f) => `  - ${f}\n`).join('')}`
  );
  process.exit(2);
}

/**
 * The population, and why it takes no pathspec: `scanPopulation` in the lib.
 * The short version is SC-755 — six globs, one of which silently contributed
 * zero while the total looked healthy.
 */
const repoRoot = new URL('..', import.meta.url).pathname;
const population = scanPopulation(repoRoot);

if (population.kind === 'refused') {
  process.stderr.write(
    `api-procedure-callers: REFUSED · NOTHING MEASURED\n  - ${population.why}\n`
  );
  process.exit(2);
}

const paths = population.paths;
const files = await Promise.all(
  paths.map(async (p) => [p, await Bun.file(`${repoRoot}/${p}`).text()] as const)
);

const result: Census = census({ apiProcedures, dataProviderProcedures, files });

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const {
  apiProcedureCount,
  dataProviderProcedureCount,
  filesScanned,
  reachedByUrl,
  urlOnly,
  typedOnly,
  noCaller,
  unresolvedUrls,
  fixturesSeen,
} = result;

const typedAndUrl = reachedByUrl.length - urlOnly.length;
const pad = (n: number) => String(n).padStart(4);

const out: string[] = [
  '',
  `api-procedure-callers: ${apiProcedureCount} api procedure(s), ${dataProviderProcedureCount} data-provider · ${filesScanned} file(s) scanned`,
  // The population, reconciled end to end. A verdict word with no count is a
  // claim about an unnamed set, and this census spent SC-755 reporting one:
  // the total looked healthy while a sixth of the tree was outside it.
  `  population: ${population.tracked} tracked → ${paths.length} TypeScript → ${paths.length - filesScanned} definition site(s) skipped → ${filesScanned} scanned`,
  '',
  `  reached by a hand-built /trpc/ URL      ${pad(reachedByUrl.length)}`,
  `    also reached through the typed client ${pad(typedAndUrl)}`,
  `    URL ONLY                              ${pad(urlOnly.length)}   <- a typed-client sweep sees NONE of these`,
  `  reached only through the typed client   ${pad(typedOnly.length)}`,
  `  no caller in this tree                  ${pad(noCaller.length)}   <- a QUESTION, not a deletion list (SC-680)`,
  '',
];

if (urlOnly.length > 0) {
  out.push('  URL ONLY — reached by a string, invisible to every typed-client pattern:');
  for (const p of urlOnly) out.push(`    ${p}`);
  out.push('');
}

if (noCaller.length > 0) {
  out.push('  no caller in this tree:');
  for (const p of noCaller) out.push(`    ${p}`);
  out.push('');
}

if (unresolvedUrls.length > 0) {
  out.push(
    `  ${unresolvedUrls.length} /trpc/ URL(s) naming no procedure on either router — a caller the`
  );
  out.push('  type checker cannot link to anything, so a rename left it behind:');
  for (const r of unresolvedUrls) out.push(`    ${r.file}:${r.line}  ${r.path}`);
  out.push('');
}

const staleFixtures = FIXTURE_URLS.filter(
  (f) => !fixturesSeen.some((s) => s.file === f.file && s.path === f.path)
);
if (staleFixtures.length > 0) {
  out.push(
    `  ${staleFixtures.length} declared fixture(s) no longer present — drop the declaration:`
  );
  for (const f of staleFixtures) out.push(`    ${f.file}  ${f.path}`);
  out.push('');
}

out.push('  What this cannot see, in the order it is likely to matter:');
out.push('    - a procedure reached dynamically: trpc[router][proc], or a URL whose');
out.push('      procedure segment comes from a variable. Nothing textual reaches those.');
out.push('    - any caller outside this repository — a saved request, an integration');
out.push('      nobody wrote down. That is why the last count is a question.');
out.push('    - anything uncommitted. The population is every tracked `.ts`/`.tsx`');
out.push('      path — `git ls-files`, no pathspec — so a call site written and not');
out.push('      staged is absent and the run is green without it.');
out.push('    - a caller in any other extension. `.js`, `.mjs` and `.astro` are');
out.push('      tracked and are not in the population; the reconciliation above is');
out.push('      what makes that visible rather than something to remember.');
out.push('');

console.log(out.join('\n'));
