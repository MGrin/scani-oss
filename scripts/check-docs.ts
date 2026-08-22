#!/usr/bin/env bun

//
// Drift check: docs vs source.
//
// Re-derives the lists the user-facing docs claim authority over —
// tRPC routers, scheduled-job cron strings, provider directories,
// env-var coverage — from the actual source files and diffs them
// against the published docs.
//
// This is the guardrail behind the audit findings cleaned up by
// PR #41 / #42 (OSS-QA-REPORT.md). The drift these caught was the
// kind that doesn't show up in type-check or tests: the docs claimed
// 8 data-provider routers when there were really 10, listed
// `transfer-linking` at 05:00 when the cron was actually 03:45,
// promised a `tier=tier2` log line that didn't exist. Without a
// programmatic check, the same drift sneaks back in within months.
//
// It has to STAY GREEN on a clean tree, and that is not a nicety
// (SC-142). It ran red on `main` for two undocumented routers, and a
// check that is red when nothing is wrong is a check everyone learns
// to scroll past — which is how the one real failure gets waved
// through as "the known one".
//
// Usage:
//   bun run docs:check            # exit 1 on any mismatch
//   bun run docs:check -- --soft  # warnings only
//
// IN THE GATE, error class only (SC-430). It had been wired only into
// `bun run check`, which nothing invokes — so three findings accumulated on
// `main` unnoticed, one of them a value a user is shown that SC-258 says must
// be in the glossary before it is translated. It is now in CLAUDE.md's
// before-pushing list, which is the gate that actually runs on this machine,
// and in `ci.yml` as `validate-docs`, which cannot run while GitHub Actions is
// billing-blocked (SC-128, SC-414) and is there for the day it is not.
//
// Only errors fail. Warnings exit 0 and stay warnings on purpose: the
// env-coverage check has too low a signal-to-noise ratio to block a PR, and a
// gate that fails the suite over a line of prose gets disabled by the third
// person it blocks — after which we are back to a check nobody runs.
//
// Each check is small and self-contained; add new ones to CHECKS at
// the bottom.
//

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const ARGS = new Set(process.argv.slice(2));
const SOFT = ARGS.has('--soft');

// Every list this file derives from the tree comes from what git TRACKS, never
// from what happens to be sitting on disk (SC-430). A working directory is not
// the repository, and reading one made this check disagree with itself across
// checkouts of the same commit: a stray `.claude/` under `providers/` was
// reported as an undocumented provider, and a framework's build output under
// `apps/frontend/` contributed three of that framework's own internal
// variables to the undocumented-env warning. Neither exists on `main`, and
// neither is in the repo at all. That is precisely the "red when nothing is
// wrong" state this file's header calls the reason a real failure gets waved
// through, and it is disqualifying for something that runs in the gate.
//
// Staged-but-uncommitted files are tracked, so adding a provider and running
// the gate before committing still fires.
const TRACKED: readonly string[] = (() => {
  const listed = Bun.spawnSync(['git', 'ls-files', '-z'], { cwd: REPO_ROOT });
  if (!listed.success) {
    console.error(
      'docs:check reads the git-tracked file list and found no git checkout at ' +
        `${REPO_ROOT}. It cannot fall back to reading the directory: build output and ` +
        'agent scratch directories there produce findings that are not in the repo.'
    );
    process.exit(2);
  }
  return listed.stdout.toString().split('\0').filter(Boolean);
})();

// Direct children of a tracked directory, split into files and subdirectories.
// A directory git does not track any file under simply does not appear — which
// is the right answer for an empty stray directory.
function childrenOf(relDir: string): { files: string[]; dirs: string[] } {
  const prefix = `${relDir}/`;
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const tracked of TRACKED) {
    if (!tracked.startsWith(prefix)) continue;
    const rest = tracked.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) files.add(rest);
    else dirs.add(rest.slice(0, slash));
  }
  return { files: [...files].sort(), dirs: [...dirs].sort() };
}

// Every tracked file under any of `roots`, filtered by extension.
function trackedUnder(roots: readonly string[], exts: readonly string[]): string[] {
  return TRACKED.filter(
    (f) => roots.some((r) => f.startsWith(`${r}/`)) && exts.some((e) => f.endsWith(e))
  );
}

type Finding = { check: string; severity: 'error' | 'warn'; message: string };
const findings: Finding[] = [];

function fail(check: string, message: string): void {
  findings.push({ check, severity: 'error', message });
}
function warn(check: string, message: string): void {
  findings.push({ check, severity: 'warn', message });
}

function read(rel: string): string {
  return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// =============================================================================
// Check 1 — data-provider router list in reference/trpc-routes.md
// =============================================================================
//
// Source of truth: `presentation/router.ts` barrel.
// Doc target: the `## data-provider` table in `reference/trpc-routes.md`.

function checkDataProviderRouters(): void {
  const NAME = 'data-provider-routers';
  const barrel = read('apps/backend/data-provider/src/presentation/router.ts');
  // Pull names from the `router({ ... })` composition block.
  const composition = barrel.match(/router\(\{([\s\S]+?)\}\)/);
  if (!composition) {
    fail(NAME, 'could not parse `router({…})` block in data-provider/presentation/router.ts');
    return;
  }
  const actual = new Set<string>();
  for (const line of composition[1].split('\n')) {
    const m = line.match(/^\s*([a-zA-Z][a-zA-Z0-9-]*)\s*[:,]/);
    if (m) actual.add(m[1]);
  }
  if (actual.size === 0) {
    fail(NAME, 'parsed zero router names from router.ts — regex broken?');
    return;
  }

  const doc = read('apps/frontend/docs/src/content/docs/reference/trpc-routes.md');
  // Find the data-provider section, then pull `\`router-name\` |` rows.
  const section = doc.split(/^## data-provider/m)[1] ?? '';
  const documented = new Set<string>();
  for (const m of section.matchAll(/^\|\s*`([a-zA-Z][a-zA-Z0-9-]*)`\s*\|/gm)) {
    documented.add(m[1]);
  }

  const missingFromDocs = [...actual].filter((n) => !documented.has(n));
  const ghostInDocs = [...documented].filter((n) => !actual.has(n));
  if (missingFromDocs.length > 0) {
    fail(
      NAME,
      `reference/trpc-routes.md is missing ${missingFromDocs.length} data-provider router(s): ${missingFromDocs.join(', ')}. Source of truth: apps/backend/data-provider/src/presentation/router.ts`
    );
  }
  if (ghostInDocs.length > 0) {
    fail(
      NAME,
      `reference/trpc-routes.md lists ${ghostInDocs.length} data-provider router(s) that do not exist in source: ${ghostInDocs.join(', ')}. Source of truth: apps/backend/data-provider/src/presentation/router.ts`
    );
  }
}

// =============================================================================
// Check 2 — api router list in reference/trpc-routes.md
// =============================================================================

function checkApiRouters(): void {
  const NAME = 'api-routers';
  const dir = 'apps/backend/api/src/presentation/routers';
  const actual = new Set<string>(
    childrenOf(dir)
      .files.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => f.replace(/\.ts$/, ''))
  );

  const doc = read('apps/frontend/docs/src/content/docs/reference/trpc-routes.md');
  const section = doc.split(/^## api/m)[1]?.split(/^## /m)[0] ?? '';
  const documented = new Set<string>();
  for (const m of section.matchAll(/^\|\s*`([a-zA-Z][a-zA-Z0-9-]*)`\s*\|/gm)) {
    documented.add(m[1]);
  }

  const missingFromDocs = [...actual].filter((n) => !documented.has(n));
  const ghostInDocs = [...documented].filter((n) => !actual.has(n));
  if (missingFromDocs.length > 0) {
    fail(
      NAME,
      `reference/trpc-routes.md is missing ${missingFromDocs.length} api router(s): ${missingFromDocs.join(', ')}. Source of truth: ${dir}/`
    );
  }
  if (ghostInDocs.length > 0) {
    fail(
      NAME,
      `reference/trpc-routes.md lists ${ghostInDocs.length} api router(s) that do not exist in source: ${ghostInDocs.join(', ')}. Source of truth: ${dir}/`
    );
  }
}

// =============================================================================
// Check 3 — scheduled-job catalogue: name + cron + registration
// =============================================================================
//
// Source of truth is BOTH of:
//   - the descriptor files in `packages/business/jobs/src/scheduled-jobs/`,
//     each declaring `name: JOB_NAMES.X` and `cron: '…'`;
//   - `SCHEDULED_JOB_DESCRIPTORS` in that directory's `index.ts`, which is the
//     list the worker actually registers.
//
// Those two are NOT the same set, and conflating them is what this check used
// to do (SC-288). A descriptor may ship before its processor exists, in which
// case it is deliberately left out of the registry — registering a schedule
// with no processor fails every tick into the DLQ instead of failing at boot.
// A page that lists such a job among the live ones is wrong in a way no
// missing-row check can see, so the doc keeps two tables and this keeps them
// honest in both directions.
//
// The cron match is MANDATORY, not best-effort. It used to fire only when the
// frequency cell happened to contain a backticked cron, so the fifteen rows
// phrased as prose were unverified — and four of them had drifted:
// `dlq-depth-probe` and `job-heartbeat-probe` documented as every 5 and every
// 10 minutes, both reconcilers as every minute, all four actually `*/15`.
// This file's own header cites the same defect from 2026-05 (`transfer-linking`
// at 05:00 against a 03:45 cron), which is the tell that a soft check here does
// not hold.

const SCHEDULED_JOBS_DOC = 'apps/frontend/docs/src/content/docs/reference/jobs.md';
const LIVE_HEADING = 'Scheduled jobs';
const UNREGISTERED_HEADING = 'Scheduled jobs — declared but not registered';

// Exact-heading section slice. A `startsWith` split would match the
// unregistered heading with the live one's prefix and silently merge them.
function docSection(doc: string, heading: string): string | null {
  const lines = doc.split('\n');
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

// name → frequency cell, for every `| \`name\` | frequency | …` row.
function tableRows(section: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const m of section.matchAll(/^\|\s*`([a-zA-Z][a-zA-Z0-9-]*)`\s*\|\s*([^|]+?)\s*\|/gm)) {
    rows.set(m[1], m[2]);
  }
  return rows;
}

function checkScheduledJobs(): void {
  const NAME = 'scheduled-jobs';
  const dir = 'packages/business/jobs/src/scheduled-jobs';
  const files = childrenOf(dir).files.filter((f) => f.endsWith('.ts') && f !== 'index.ts');

  // The registry the worker boots from, read as the literal list of exported
  // const names inside `SCHEDULED_JOB_DESCRIPTORS = [ … ] as const`. A
  // commented-out entry is therefore correctly read as NOT registered.
  const index = read(`${dir}/index.ts`);
  const registryBlock = index.split('SCHEDULED_JOB_DESCRIPTORS = [')[1]?.split('] as const')[0];
  if (registryBlock === undefined) {
    fail(NAME, `could not locate SCHEDULED_JOB_DESCRIPTORS in ${dir}/index.ts`);
    return;
  }
  const registered = new Set(
    Array.from(registryBlock.matchAll(/^\s*([A-Z][A-Z0-9_]*_SCHEDULE)\s*,/gm)).map((m) => m[1])
  );

  const cron = new Map<string, string>();
  const isRegistered = new Map<string, boolean>();
  for (const file of files) {
    const name = file.replace(/\.ts$/, '');
    const src = read(`${dir}/${file}`);
    const cronMatch = src.match(/cron:\s*['"`]([^'"`]+)['"`]/);
    const constMatch = src.match(/export const ([A-Z][A-Z0-9_]*_SCHEDULE)/);
    if (!cronMatch) {
      fail(NAME, `could not parse cron from ${dir}/${file}`);
      continue;
    }
    if (!constMatch) {
      fail(NAME, `could not parse the exported \`*_SCHEDULE\` const from ${dir}/${file}`);
      continue;
    }
    cron.set(name, cronMatch[1]);
    isRegistered.set(name, registered.has(constMatch[1]));
  }

  const doc = read(SCHEDULED_JOBS_DOC);
  const liveSection = docSection(doc, LIVE_HEADING);
  const unregisteredSection = docSection(doc, UNREGISTERED_HEADING);
  if (liveSection === null) {
    fail(NAME, `reference/jobs.md has no \`## ${LIVE_HEADING}\` section`);
    return;
  }
  if (unregisteredSection === null) {
    fail(NAME, `reference/jobs.md has no \`## ${UNREGISTERED_HEADING}\` section`);
    return;
  }
  const live = tableRows(liveSection);
  const unregisteredRows = tableRows(unregisteredSection);

  for (const [name, expectedCron] of cron) {
    const shouldBeLive = isRegistered.get(name) === true;
    const table = shouldBeLive ? live : unregisteredRows;
    const wrongTable = shouldBeLive ? unregisteredRows : live;
    const rightHeading = shouldBeLive ? LIVE_HEADING : UNREGISTERED_HEADING;

    if (!table.has(name)) {
      if (wrongTable.has(name)) {
        fail(
          NAME,
          shouldBeLive
            ? `reference/jobs.md lists \`${name}\` as not registered, but it IS in SCHEDULED_JOB_DESCRIPTORS. Move it to \`## ${rightHeading}\`.`
            : `reference/jobs.md lists \`${name}\` among the live jobs, but it is NOT in SCHEDULED_JOB_DESCRIPTORS, so it never runs. Move it to \`## ${rightHeading}\`.`
        );
      } else {
        fail(
          NAME,
          `reference/jobs.md is missing scheduled job \`${name}\` (cron \`${expectedCron}\`) from \`## ${rightHeading}\`. Source: ${dir}/${name}.ts`
        );
      }
      continue;
    }

    // Present in the right table is not enough — it must be ABSENT from the
    // other one. A row in both reads as live to anyone who stops at the first
    // table, which is the exact claim the split exists to prevent.
    if (wrongTable.has(name)) {
      fail(
        NAME,
        `reference/jobs.md lists \`${name}\` in BOTH job tables. It belongs only under \`## ${rightHeading}\`.`
      );
    }

    // Mandatory: the frequency cell must state the cron verbatim in backticks.
    const cell = table.get(name) ?? '';
    const docCron = cell.match(/`([-0-9*/, ]+)`/)?.[1];
    if (docCron === undefined) {
      fail(
        NAME,
        `reference/jobs.md frequency for \`${name}\` states no cron — it must contain \`${expectedCron}\` verbatim, or prose drift goes unnoticed. Cell: "${cell}"`
      );
      continue;
    }
    if (docCron !== expectedCron) {
      fail(
        NAME,
        `reference/jobs.md cron for \`${name}\` is \`${docCron}\` but source has \`${expectedCron}\`. Source: ${dir}/${name}.ts`
      );
    }
  }

  for (const [heading, rows] of [
    [LIVE_HEADING, live],
    [UNREGISTERED_HEADING, unregisteredRows],
  ] as const) {
    for (const name of rows.keys()) {
      if (!cron.has(name)) {
        fail(
          NAME,
          `reference/jobs.md \`## ${heading}\` lists scheduled job \`${name}\` that does not exist under ${dir}/`
        );
      }
    }
  }
}

// =============================================================================
// Check 4 — user-initiated job catalogue in reference/jobs.md
// =============================================================================

function checkUserJobs(): void {
  const NAME = 'user-jobs';
  const dir = 'packages/business/jobs/src/user-jobs';
  const actual = new Set<string>(
    childrenOf(dir)
      .files.filter((f) => f.endsWith('.ts') && f !== 'index.ts')
      .map((f) => f.replace(/\.ts$/, ''))
  );

  const doc = read('apps/frontend/docs/src/content/docs/reference/jobs.md');
  const section = doc.split(/^## User-initiated jobs/m)[1]?.split(/^## /m)[0] ?? '';
  const documented = new Set<string>();
  for (const m of section.matchAll(/^\|\s*`([a-zA-Z][a-zA-Z0-9-]*)`\s*\|/gm)) {
    documented.add(m[1]);
  }

  for (const name of actual) {
    if (!documented.has(name)) {
      fail(NAME, `reference/jobs.md is missing user job \`${name}\`. Source: ${dir}/${name}.ts`);
    }
  }
  for (const name of documented) {
    if (!actual.has(name)) {
      fail(NAME, `reference/jobs.md lists user job \`${name}\` that does not exist under ${dir}/`);
    }
  }
}

// =============================================================================
// Check 5 — worker processor file list in apps/backend/worker/README.md
// =============================================================================
//
// The worker README enumerates processor files. Drift was the audit's
// most common finding (was 18 listed, 24 actually shipped).

function checkWorkerProcessors(): void {
  const NAME = 'worker-processors';
  const dir = 'apps/backend/worker/src/processors';
  const actual = new Set<string>(
    childrenOf(dir)
      .files.filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => f.replace(/\.ts$/, ''))
  );

  const doc = read('apps/backend/worker/README.md');
  // Scope to just the `processors/` block — the boot-flow tree above
  // also has `├── index.ts`, `├── env.ts` etc. which we don't want to
  // count as processors.
  const block = doc.match(/└── processors\/[\s\S]+?```/);
  if (!block) {
    warn(NAME, 'could not locate processors/ block in worker README');
    return;
  }
  const documented = new Set<string>();
  for (const m of block[0].matchAll(/[├└]──\s*([a-zA-Z][a-zA-Z0-9-]*)\.ts/g)) {
    documented.add(m[1]);
  }
  if (documented.size === 0) {
    warn(NAME, 'parsed zero processor names from worker README — list format may have changed');
    return;
  }

  const missingFromDocs = [...actual].filter((n) => !documented.has(n));
  const ghostInDocs = [...documented].filter((n) => !actual.has(n));
  if (missingFromDocs.length > 0) {
    fail(
      NAME,
      `apps/backend/worker/README.md is missing ${missingFromDocs.length} processor(s): ${missingFromDocs.join(', ')}. Source: ${dir}/`
    );
  }
  if (ghostInDocs.length > 0) {
    fail(
      NAME,
      `apps/backend/worker/README.md lists ${ghostInDocs.length} processor(s) that do not exist: ${ghostInDocs.join(', ')}. Source: ${dir}/`
    );
  }
}

// =============================================================================
// Check 6 — provider directory list in reference/provider-matrix.md
// =============================================================================
//
// The provider matrix tabulates every adapter. Adding a provider but
// forgetting to document it is exactly the kind of drift we're guarding
// against; this check fires on any new directory.

function checkProviders(): void {
  const NAME = 'providers';
  const dir = 'packages/clients/providers/src/providers';
  const actual = new Set<string>(childrenOf(dir).dirs);
  // Add the separate workspace too.
  if (TRACKED.some((f) => f.startsWith('packages/clients/providers-google-sheets/'))) {
    actual.add('google-sheets');
  }

  const doc = read('apps/frontend/docs/src/content/docs/reference/provider-matrix.md');
  // The matrix mixes capitalised display names (Binance, Kraken) with
  // lowercase directory names. Match either by the directory name
  // appearing anywhere (case-insensitive) so a "Bitget" entry counts
  // for the `bitget` directory.
  const lowerDoc = doc.toLowerCase();
  const missing: string[] = [];
  for (const dirName of actual) {
    // Try the directory name verbatim and a couple of common humanisations.
    const variants = new Set<string>([
      dirName,
      dirName.replace(/-/g, ' '),
      dirName.replace(/^ai-/, ''),
    ]);
    const found = [...variants].some((v) => lowerDoc.includes(v.toLowerCase()));
    if (!found) missing.push(dirName);
  }
  if (missing.length > 0) {
    fail(
      NAME,
      `reference/provider-matrix.md does not mention ${missing.length} provider directory(ies): ${missing.join(', ')}. Source: ${dir}/`
    );
  }
}

// =============================================================================
// Check 7 — env-var coverage: every var referenced in code should be
// documented in .env.example OR reference/environment.md (soft check).
// =============================================================================
//
// This is intentionally a warning, not an error: a lot of test files
// and one-off scripts read transient env vars that aren't worth
// documenting. The signal-to-noise is too low for a hard fail. Promote
// individual vars to a hard list if they're worth tracking.

function checkEnvVarCoverage(): void {
  const NAME = 'env-coverage';

  // Collect `process.env.XXX` references from apps + packages source.
  const referenced = new Set<string>();
  const sources = trackedUnder(['apps', 'packages'], ['.ts', '.tsx', '.mjs', '.cjs']).filter(
    (f) => !f.endsWith('.test.ts') && !f.endsWith('.test.tsx')
  );
  for (const file of sources) {
    const src = read(file);
    for (const m of src.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]+)/g)) {
      referenced.add(m[1]);
    }
    for (const m of src.matchAll(/import\.meta\.env\.([A-Z][A-Z0-9_]+)/g)) {
      referenced.add(m[1]);
    }
  }

  // Vars documented in .env.example (including commented-out entries).
  const documented = new Set<string>();
  for (const file of ['.env.example', 'apps/backend/api/.env.example']) {
    if (!existsSync(path.join(REPO_ROOT, file))) continue;
    const src = read(file);
    for (const m of src.matchAll(/^[#\s]*([A-Z][A-Z0-9_]+)\s*=/gm)) {
      documented.add(m[1]);
    }
  }
  // Also pull any `\`VAR\`` mentions from reference/environment.md.
  const envRef = read('apps/frontend/docs/src/content/docs/reference/environment.md');
  for (const m of envRef.matchAll(/`([A-Z][A-Z0-9_]+)`/g)) {
    documented.add(m[1]);
  }

  // Vars we intentionally don't track (test-runner, build-tool, OS,
  // Vite's built-in environment globals).
  const IGNORE = new Set<string>([
    'NODE_ENV',
    'CI',
    'GITHUB_ACTIONS',
    'GITHUB_SHA',
    'GITHUB_RUN_ID',
    'GITHUB_REF',
    'PATH',
    'HOME',
    'PWD',
    'HOSTNAME',
    'TZ',
    'TERM',
    'TMPDIR',
    'DEBUG',
    'NPM_CONFIG_USERCONFIG',
    'BUN_INSTALL',
    // Vite's built-in `import.meta.env.{MODE,DEV,PROD,SSR,BASE_URL}`
    'MODE',
    'DEV',
    'PROD',
    'SSR',
    'BASE_URL',
    // The literal `VITE_` prefix sometimes appears in a template string
    // like `import.meta.env.VITE_${name}`; not a real var name.
    'VITE_',
    // Internal worker / build-time markers documented inline next to
    // their usage rather than in .env.example.
    'IS_CRON_JOB',
    // Vite Sentry build-time markers, baked into the SPA at build time
    // via the build script — operators don't set these directly.
    'VITE_APP_VERSION',
    'VITE_SENTRY_ENVIRONMENT',
    'VITE_SENTRY_RELEASE',
  ]);

  const undocumented = [...referenced]
    .filter((v) => !documented.has(v))
    .filter((v) => !IGNORE.has(v))
    .sort();

  if (undocumented.length > 0) {
    warn(
      NAME,
      `${undocumented.length} env var(s) referenced in code but not in .env.example or reference/environment.md: ${undocumented.join(', ')}`
    );
  }
}

// =============================================================================
// Check 8 — the glossary's domain vocabulary against the code's own enums
// =============================================================================
//
// SC-258. The glossary is the input eight translations are generated from,
// and a wrong translation of `left_control` misstates a tax-shaped number.
// A glossary nobody checks falls behind the first time a value is added to
// one of these unions — silently, because a missing term looks exactly like
// a term nobody needed.
//
// Deliberately one-directional: every value in the code must appear in the
// glossary, but the glossary may say more than the code enumerates (it also
// defines words that are not enum members). The check is on the literal wire
// value in code font, which is what a translator has to be able to look up.

const GLOSSARY = 'apps/frontend/docs/src/content/docs/reference/glossary.md';

function checkGlossaryTerms(): void {
  const NAME = 'glossary-terms';
  const doc = read(GLOSSARY);

  // Each source is a file plus the pattern that enumerates its values, so a
  // new member is picked up here without anyone remembering to come back.
  const sources: Array<{ label: string; file: string; pattern: RegExp }> = [
    {
      label: 'TRANSFER_REVIEW_DECISIONS',
      file: 'packages/business/shared/src/dtos/transfer-review.ts',
      pattern: /export const TRANSFER_REVIEW_DECISIONS = \[([\s\S]+?)\] as const/,
    },
    {
      label: 'ANSWER_SOURCES',
      file: 'packages/business/shared/src/dtos/transfer-review.ts',
      pattern: /export const ANSWER_SOURCES = \[([\s\S]+?)\] as const/,
    },
    {
      label: 'TRANSFER_CANDIDATE_REASONS',
      file: 'packages/business/shared/src/dtos/transfer-review.ts',
      pattern: /export const TRANSFER_CANDIDATE_REASONS = \[([\s\S]+?)\] as const/,
    },
    {
      label: 'DisposalOutcome',
      file: 'packages/business/domain/src/services/pricing/CostBasisService.ts',
      pattern: /export type DisposalOutcome =([^;]+);/,
    },
    {
      label: 'CostBasisQuality',
      file: 'packages/business/domain/src/services/pricing/CostBasisService.ts',
      pattern: /export type CostBasisQuality =([^;]+);/,
    },
    {
      label: 'HistoryCompleteness',
      file: 'packages/business/domain/src/services/pricing/CostBasisService.ts',
      pattern: /export type HistoryCompleteness =([^;]+);/,
    },
    {
      label: 'CoverageQuality',
      file: 'packages/infra/db/src/schema/portfolio.ts',
      pattern: /export type CoverageQuality =([^;]+);/,
    },
    {
      label: 'BalanceAtTimeResult.anchor',
      file: 'packages/business/domain/src/services/pricing/BalanceAtTimeService.ts',
      pattern: /anchor: ('holdings'[^;]+);/,
    },
  ];

  for (const { label, file, pattern } of sources) {
    const block = read(file).match(pattern)?.[1];
    if (!block) {
      fail(
        NAME,
        `could not read ${label} from ${file} — the pattern in check-docs.ts needs updating`
      );
      continue;
    }
    const values = [...block.matchAll(/'([a-z_-]+)'/g)].map((m) => m[1]).filter(Boolean);
    if (values.length === 0) {
      fail(NAME, `${label} in ${file} parsed to zero values — the pattern is wrong`);
      continue;
    }
    const missing = values.filter((v) => !doc.includes(`\`${v}\``));
    if (missing.length > 0) {
      fail(
        NAME,
        `reference/glossary.md does not define ${missing.length} ${label} value(s): ${missing.join(', ')}. Every value a user can be shown needs an entry before it is translated (SC-258). Source: ${file}`
      );
    }
  }
}

// =============================================================================
// Check 9 — one spelling of "realized" on every surface a user reads
// =============================================================================
//
// SC-261. The published glossary spelled it `realised`; the shipped UI spells
// it `realized`, as does every identifier behind it (`realizedPnl`,
// `RealizedLedgerService`, `portfolio_value_daily.realized_pnl`). Harmless in
// English and not harmless downstream: SC-201 generates eight locales against
// that glossary, and in Russian, Japanese or Arabic nothing signals that
// `realised gain` and `Realized PnL` are one term. The risk is two
// translations of one concept with no reviewer able to see it.
//
// Scoped to what users read — the docs site and the SPA. `docs/` is internal
// and may quote the old spelling when recording why it changed; postmortems in
// particular are historical records and are never rewritten to match the
// present.
//
// `realistic` is a different word and is left alone.

function checkRealizedSpelling(): void {
  const NAME = 'realized-spelling';
  const BRITISH = /\b(un)?realis(e|ed|es|ing|ation)\b/i;
  const roots = ['apps/frontend/docs/src/content', 'apps/frontend/app/src'];
  const exts = ['.md', '.mdx', '.ts', '.tsx', '.json'];

  const offenders: string[] = [];
  for (const file of trackedUnder(roots, [...exts])) {
    read(file)
      .split('\n')
      .forEach((line, i) => {
        if (BRITISH.test(line)) offenders.push(`${file}:${i + 1}`);
      });
  }

  if (offenders.length > 0) {
    fail(
      NAME,
      `${offenders.length} user-facing line(s) spell it the British way; this product spells it "realized", matching the UI and every identifier (SC-261): ${offenders.slice(0, 10).join(', ')}${offenders.length > 10 ? ', …' : ''}`
    );
  }
}

// =============================================================================
// Check 10 — a .md outside docs/ has to be somewhere its location earns it
// =============================================================================
//
// The rule this enforces used to read "never create `.md` files at the repo
// root (the only allowed roots are README.md, CONTRIBUTING.md, CLAUDE.md) or
// anywhere under `apps/*` / `packages/*/src/`", stated in `docs/README.md`,
// twice in `CLAUDE.md`, and again in `CONTRIBUTING.md`. It was false about
// this repo in both directions at once (SC-444).
//
// Too weak: `packages/*/src/` matches nothing. Packages sit two levels deep
// (`packages/clients/providers`), so in an ordinary shell the clause that
// looks strictest forbade zero files. Too strong: corrected to
// `packages/*/*/src/` it forbids the 24 provider READMEs — including the IBKR
// one SC-442 was asked to REPAIR — and `apps/*` already forbade 41 pages of
// the published docs site plus `apps/backend/worker/README.md`, which check 5
// in this same file REQUIRES. A rule that forbids what the gate requires does
// not get followed carefully; it gets ignored wholesale, and the part that
// mattered goes with it.
//
// So the rule is positive now: documentation about the repo lives in `docs/`,
// and a `.md` anywhere else has to be in a place where its location is what
// makes it work — a README is what every tool shows when you open a
// directory, `.github/` is read from fixed paths, the docs site's content is
// the product, and `docker-readmes/` is pushed to Docker Hub. The test for a
// new file is whether moving it to `docs/` would break a tool or hide it from
// someone opening that directory. If it would only be less convenient for
// you, it belongs in `docs/`.
//
// It lives in the gate rather than only in prose because three files stating
// one rule is three files that can drift, which is the failure SC-438, SC-439
// and SC-440 were each about.

function checkMarkdownPlacement(): void {
  const NAME = 'md-placement';

  // Root files pinned there by convention or by a tool that looks for them.
  // `CHANGELOG.md` is written at the root by release-please and read from there
  // by GitHub's release page and the Docker Hub description sync; moving it
  // under docs/ would leave the generator recreating it on the next release.
  const ROOT_ALLOWED = new Set([
    'README.md',
    'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md',
    'CLAUDE.md',
    'CHANGELOG.md',
  ]);

  // A README by function under a name GitHub does not auto-render: it sits
  // beside the locale JSON files so a translator who opens that directory
  // finds it, and `apps/frontend/app/README.md` links to it. Renaming it to
  // README.md would retire this exception.
  const NAMED_EXCEPTIONS = new Set(['apps/frontend/app/src/i18n/locales/CONTRIBUTORS.md']);

  const allowed = (file: string): boolean => {
    if (file.startsWith('docs/')) return true;
    // A README is the one file whose location is its whole point — it is what
    // GitHub, npm and every editor show for the directory it names. Which
    // directories may have one is deliberately NOT restricted: that
    // over-specification is what made the old rule forbid the provider
    // READMEs.
    if (file === 'README.md' || file.endsWith('/README.md')) return true;
    if (!file.includes('/')) return ROOT_ALLOWED.has(file);
    // GitHub reads these from fixed paths; they cannot move.
    if (file.startsWith('.github/')) return true;
    // The published docs site at docs.scani.xyz. This content IS the product,
    // not documentation about the repo.
    if (file.startsWith('apps/frontend/docs/src/content/')) return true;
    // Docker Hub image descriptions, pushed by scripts/sync-dockerhub-readme.ts.
    if (file.startsWith('docker-readmes/')) return true;
    return NAMED_EXCEPTIONS.has(file);
  };

  const offenders = TRACKED.filter((f) => f.endsWith('.md') && !allowed(f));
  if (offenders.length > 0) {
    fail(
      NAME,
      `${offenders.length} markdown file(s) sit outside docs/ without a reason their location earns: ` +
        `${offenders.join(', ')}. Move them under docs/ (see docs/README.md for the slots), or ` +
        'if the location is load-bearing, say so in this check.'
    );
  }
}

// =============================================================================
// Runner
// =============================================================================

const CHECKS: Array<() => void> = [
  checkDataProviderRouters,
  checkApiRouters,
  checkScheduledJobs,
  checkUserJobs,
  checkWorkerProcessors,
  checkProviders,
  checkEnvVarCoverage,
  checkGlossaryTerms,
  checkRealizedSpelling,
  checkMarkdownPlacement,
];

for (const check of CHECKS) {
  try {
    check();
  } catch (err) {
    fail(check.name, `crashed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const errors = findings.filter((f) => f.severity === 'error');
const warnings = findings.filter((f) => f.severity === 'warn');

for (const f of warnings) {
  console.warn(`⚠️  [${f.check}] ${f.message}`);
}
for (const f of errors) {
  console.error(`❌ [${f.check}] ${f.message}`);
}

if (errors.length === 0 && warnings.length === 0) {
  console.log(`✅ docs:check — all ${CHECKS.length} checks passed`);
  process.exit(0);
}

console.log('');
console.log(`docs:check — ${errors.length} error(s), ${warnings.length} warning(s)`);

if (errors.length > 0 && !SOFT) {
  process.exit(1);
}
process.exit(0);
