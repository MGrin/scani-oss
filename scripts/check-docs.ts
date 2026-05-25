#!/usr/bin/env bun

//
// Drift check: docs vs source.
//
// Re-derives the lists the user-facing docs claim authority over —
// tRPC routers, scheduled-job cron strings, provider directories,
// env-var coverage — from the actual source files and diffs them
// against the published docs. Anything out of sync fails CI.
//
// This is the guardrail behind the audit findings cleaned up by
// PR #41 / #42 (OSS-QA-REPORT.md). The drift these caught was the
// kind that doesn't show up in type-check or tests: the docs claimed
// 8 data-provider routers when there were really 10, listed
// `transfer-linking` at 05:00 when the cron was actually 03:45,
// promised a `tier=tier2` log line that didn't exist. Without a
// programmatic check, the same drift sneaks back in within months.
//
// Usage:
//   bun run docs:check            # exit 1 on any mismatch
//   bun run docs:check -- --soft  # warnings only (used by `pre-push`)
//
// Each check is small and self-contained; add new ones to CHECKS at
// the bottom.
//

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const ARGS = new Set(process.argv.slice(2));
const SOFT = ARGS.has('--soft');

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
    readdirSync(path.join(REPO_ROOT, dir))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
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
// Check 3 — scheduled-job catalogue: name + cron in reference/jobs.md
// =============================================================================
//
// Source of truth: each descriptor in
// `packages/business/jobs/src/scheduled-jobs/<name>.ts` declares
// `name: JOB_NAMES.X` and `cron: '…'`.
// Doc target: the `## Scheduled jobs` table in `reference/jobs.md`.

function checkScheduledJobs(): void {
  const NAME = 'scheduled-jobs';
  const dir = 'packages/business/jobs/src/scheduled-jobs';
  const files = readdirSync(path.join(REPO_ROOT, dir)).filter(
    (f) => f.endsWith('.ts') && f !== 'index.ts'
  );

  // Map filename (== job kebab name) → cron string.
  const actual = new Map<string, string>();
  for (const file of files) {
    const src = read(`${dir}/${file}`);
    const cronMatch = src.match(/cron:\s*['"`]([^'"`]+)['"`]/);
    if (!cronMatch) {
      fail(NAME, `could not parse cron from ${dir}/${file}`);
      continue;
    }
    actual.set(file.replace(/\.ts$/, ''), cronMatch[1]);
  }

  // Walk the `## Scheduled jobs` table for name + frequency cells.
  const doc = read('apps/frontend/docs/src/content/docs/reference/jobs.md');
  const section = doc.split(/^## Scheduled jobs/m)[1]?.split(/^## /m)[0] ?? '';
  const documented = new Map<string, string>();
  for (const row of section.matchAll(/^\|\s*`([a-zA-Z][a-zA-Z0-9-]*)`\s*\|\s*([^|]+?)\s*\|/gm)) {
    documented.set(row[1], row[2]);
  }

  for (const [name, cron] of actual) {
    if (!documented.has(name)) {
      fail(
        NAME,
        `reference/jobs.md is missing scheduled job \`${name}\` (cron \`${cron}\`). Source: ${dir}/${name}.ts`
      );
      continue;
    }
    // Soft check: if the doc cell mentions a cron string verbatim, it must match.
    const cell = documented.get(name) ?? '';
    const docCron = cell.match(/`([0-9*/, ]+)`/)?.[1];
    if (docCron && docCron !== cron) {
      fail(
        NAME,
        `reference/jobs.md cron for \`${name}\` is \`${docCron}\` but source has \`${cron}\`. Source: ${dir}/${name}.ts`
      );
    }
  }
  for (const name of documented.keys()) {
    if (!actual.has(name)) {
      fail(
        NAME,
        `reference/jobs.md lists scheduled job \`${name}\` that does not exist under ${dir}/`
      );
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
    readdirSync(path.join(REPO_ROOT, dir))
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
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
    readdirSync(path.join(REPO_ROOT, dir))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
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
  const actual = new Set<string>(
    readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  );
  // Add the separate workspace too.
  if (existsSync(path.join(REPO_ROOT, 'packages/clients/providers-google-sheets'))) {
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
  const SCAN_DIRS = ['apps', 'packages'];
  for (const root of SCAN_DIRS) {
    const stack: string[] = [path.join(REPO_ROOT, root)];
    while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) break;
      const entries = (() => {
        try {
          return readdirSync(dir, { withFileTypes: true });
        } catch {
          return [];
        }
      })();
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          stack.push(full);
          continue;
        }
        if (!/\.(ts|tsx|mjs|cjs)$/.test(entry.name)) continue;
        if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue;
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(/\bprocess\.env\.([A-Z][A-Z0-9_]+)/g)) {
          referenced.add(m[1]);
        }
        for (const m of src.matchAll(/import\.meta\.env\.([A-Z][A-Z0-9_]+)/g)) {
          referenced.add(m[1]);
        }
      }
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
