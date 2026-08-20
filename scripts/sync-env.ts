#!/usr/bin/env bun
/**
 * Sync per-app .env files from the root .env (single source of truth),
 * creating that root .env from `.env.example` when it does not exist.
 *
 * The contract: each app's `.env.example` enumerates the variables that
 * app reads. This script parses every key it finds in the example
 * (including commented-out optional keys like `# OPENAI_API_KEY=`),
 * looks each one up in the root `.env`, and writes the resolved subset
 * to the app's runtime `.env` file.
 *
 * Adding a new variable to an app is therefore a one-file change: drop
 * it into that app's `.env.example`. The sync script auto-picks it up.
 *
 * WHY IT BOOTSTRAPS THE ROOT FILE (SC-474). This script used to exit 1
 * with `run \`cp .env.example .env\` first`, and it is the first thing
 * `bun run dev:stack` does — so a fresh worktree could not start the
 * stack, could not therefore run `bun run visual` or open a screen, and
 * every UI ticket arrived at review with the one claim that matters
 * (what it looks like) unverified. Telling a person to copy a file and
 * refusing to do it for them buys nothing: there is no decision in the
 * copy. So the copy happens here, once, and never again — an existing
 * root .env is read, never rewritten.
 *
 * Run automatically by the `env-sync` compose service on `docker compose up`,
 * and by `bun run dev:stack` before the stack boots. Safe to re-run;
 * overwrites the per-app target files every time.
 *
 *   bun scripts/sync-env.ts          # uses default root .env
 *   ROOT_ENV=/path/to/.env bun scripts/sync-env.ts
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const thisFile = new URL(import.meta.url).pathname;
const repoRoot = resolve(dirname(thisFile), '..');
const rootEnvPath = process.env.ROOT_ENV ?? resolve(repoRoot, '.env');
const rootExamplePath = resolve(repoRoot, '.env.example');

// Minimal KEY=VALUE parser. Does not handle multiline values or shell
// expansion — neither is used in our .env.example. Quoted strings get
// their outer quotes stripped for compatibility with shells that re-read
// the file directly (e.g. `source .env`).
export function parseEnv(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// Extract every variable name an app declares in its `.env.example`.
// Matches both active entries (`FOO=bar`) and commented-out optional
// entries (`# FOO=`) — the latter document "this var is used but not
// required". A var makes it into the output only if the root .env
// actually sets it.
const ENV_KEY_RE = /^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/;

export function parseAllowedKeys(src: string): string[] {
  const keys = new Set<string>();
  for (const rawLine of src.split('\n')) {
    const match = rawLine.match(ENV_KEY_RE);
    if (match) keys.add(match[1]);
  }
  return [...keys];
}

/**
 * Keys the bootstrap fills in rather than copying across verbatim.
 *
 * `.env.example` is a public file, so anything it ships as a literal is
 * not a secret and cannot be one. Every other dev placeholder in there
 * (`ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, `JOBS_HMAC_SECRET`, …) is
 * *deliberately* a known constant: `docker-compose.yml` hardcodes the
 * same literals on the backend and worker services, and generating a
 * different value here would hand the host-side process a key the
 * containers do not share — credentials written by one become
 * undecryptable by the other. So they are copied, not generated.
 *
 * `LOG_ID_PEPPER` is the one that can be generated safely: nothing
 * matches on it, it is per-install by design, and 64 hex chars clears
 * @scani/logging's 16-char floor with room to spare.
 */
const GENERATED_KEYS = new Set(['LOG_ID_PEPPER']);

const GENERATED_NOTE: Record<string, string> = {
  LOG_ID_PEPPER:
    '# Generated for this checkout by scripts/sync-env.ts — it is not shared with\n' +
    '# anyone and does not need to be. Dev does not require a pepper (@scani/logging\n' +
    '# only refuses without one under NODE_ENV=production); one is generated so local\n' +
    '# logs pseudonymize IDs the way production does. Blank the value to log raw IDs.',
};

export function generateSecret(): string {
  return randomBytes(32).toString('hex');
}

/**
 * The root `.env` a fresh checkout gets: `.env.example` verbatim — every
 * comment in it is documentation someone will want when they add an API
 * key — with the generated keys filled in where the example ships them
 * blank.
 */
export function renderRootEnv(exampleSrc: string, secret: () => string = generateSecret): string {
  const lines = exampleSrc.split('\n');
  const out: string[] = [];
  for (const line of lines) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=\s*$/);
    if (!match || !GENERATED_KEYS.has(match[1])) {
      out.push(line);
      continue;
    }
    const note = GENERATED_NOTE[match[1]];
    if (note) out.push(note);
    out.push(`${match[1]}=${secret()}`);
  }
  return out.join('\n');
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Create the root `.env` if — and only if — there is not one already.
 *
 * The "only if" is the load-bearing half and is why it lives in here rather
 * than at the call site: a root `.env` holds whatever provider keys its owner
 * pasted in, and this script runs unattended on every `docker compose up`.
 * Returns false without touching anything when the file exists.
 *
 * `flag: 'wx'` rather than an `existsSync` guard, so "does it exist" and "do
 * not overwrite it" are one syscall instead of two with a window between
 * them. `docker compose up` starts the `env-sync` service while a person may
 * be running `bun run dev:stack` in the same checkout, and a lost `.env` is
 * not a recoverable kind of race.
 */
export function bootstrapRootEnv(envPath: string, examplePath: string): boolean {
  const example = readIfPresent(examplePath);
  if (example === null) {
    console.error(
      `❌ neither ${envPath} nor ${examplePath} exists.\n` +
        `   There is nothing to bootstrap from — is this a complete checkout?`
    );
    process.exit(1);
  }
  try {
    writeFileSync(envPath, renderRootEnv(example), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  const generated = [...GENERATED_KEYS].join(', ');
  console.log(
    `✅ wrote ${envPath} from .env.example (mode 600) — generated ${generated}.\n` +
      `   Edit it to add provider API keys; it is gitignored and never rewritten.`
  );
  return true;
}

const HEADER = `# Auto-generated by scripts/sync-env.ts from the root .env.
# Do NOT edit by hand — your changes will be overwritten on the next sync.
# To add or remove a variable for this app, edit this directory's
# .env.example, then re-run \`bun scripts/sync-env.ts\`.
`;

// Variables that identify the *process*, not the deployment. The root .env
// holds one value for each, so inheriting them would hand every backend the
// same one: `PORT=3001` from the root made data-provider bind the api's port,
// and the api crashed at boot on the `SERVICE_NAME !== 'api'` guard
// in @scani/realtime because the root .env has no SERVICE_NAME to inherit.
// For these keys the app's own `.env.example` default wins.
const PER_PROCESS_KEYS = new Set(['PORT', 'HOST', 'SERVICE_NAME']);

function render(
  keys: string[],
  root: Record<string, string>,
  appDefaults: Record<string, string>
): string {
  const lines: string[] = [HEADER];
  for (const key of keys) {
    // Root .env wins, except for the per-process keys above.
    const value = PER_PROCESS_KEYS.has(key)
      ? (appDefaults[key] ?? root[key])
      : (root[key] ?? appDefaults[key]);
    if (value === undefined) continue;
    lines.push(`${key}=${value}`);
  }
  lines.push('');
  return lines.join('\n');
}

// Per-app output filename override. Apps that need `.env.local` (Next.js
// reads it with higher priority than `.env`) can opt in here. Everyone
// else gets `.env`.
const OUTPUT_FILENAME: Record<string, string> = {};

function main(): void {
  bootstrapRootEnv(rootEnvPath, rootExamplePath);

  const root = parseEnv(readFileSync(rootEnvPath, 'utf8'));

  // Apps live at `apps/<category>/<name>/` (category = `backend` or
  // `frontend`). Walk both levels and collect every leaf with `.env.example`.
  const appsDir = resolve(repoRoot, 'apps');
  const apps: { relative: string; absolute: string; name: string }[] = [];
  for (const category of readdirSync(appsDir, { withFileTypes: true })) {
    if (!category.isDirectory()) continue;
    const categoryPath = resolve(appsDir, category.name);
    for (const app of readdirSync(categoryPath, { withFileTypes: true })) {
      if (!app.isDirectory()) continue;
      const appPath = resolve(categoryPath, app.name);
      if (!existsSync(resolve(appPath, '.env.example'))) continue;
      apps.push({
        relative: `${category.name}/${app.name}`,
        absolute: appPath,
        name: app.name,
      });
    }
  }

  if (apps.length === 0) {
    console.warn('⚠️  No apps with .env.example found under apps/ — nothing to do.');
    process.exit(0);
  }

  for (const app of apps) {
    const examplePath = resolve(app.absolute, '.env.example');
    const exampleSrc = readFileSync(examplePath, 'utf8');
    const allowedKeys = parseAllowedKeys(exampleSrc);
    const appDefaults = parseEnv(exampleSrc);
    const outputName = OUTPUT_FILENAME[app.name] ?? '.env';
    const outPath = resolve(app.absolute, outputName);
    mkdirSync(dirname(outPath), { recursive: true });
    const rendered = render(allowedKeys, root, appDefaults);
    // Skip the write when content is unchanged. Vite's dotenv watcher
    // restarts the dev server on any mtime bump, and an unconditional
    // rewrite here (fired every time the `env-sync` compose service reruns,
    // e.g. on backend rebuilds) has repeatedly deadlocked Vite mid-restart.
    // Idempotency fixes that at the source.
    const current = readIfPresent(outPath);
    const resolved = allowedKeys.filter(
      (k) => root[k] !== undefined || appDefaults[k] !== undefined
    ).length;
    if (current === rendered) {
      console.log(
        `↻ apps/${app.relative}/${outputName} unchanged — ${resolved}/${allowedKeys.length} vars resolved (skipped)`
      );
      continue;
    }
    writeFileSync(outPath, rendered, { mode: 0o600 });
    console.log(
      `✅ wrote apps/${app.relative}/${outputName} — ${resolved}/${allowedKeys.length} vars resolved (root .env or .env.example)`
    );
  }
}

if (import.meta.main) main();
