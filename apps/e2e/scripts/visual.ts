#!/usr/bin/env bun

/**
 * `bun run visual` — the visual-regression gate (SC-24).
 *
 * The ticket specified that baselines be generated "in CI only, inside the
 * Playwright Docker image", because macOS-rendered PNGs will never match
 * `ubuntu-latest`. The reasoning is right and the mechanism is gone: GitHub
 * Actions is billing-blocked account-wide (SC-128, SC-414). But the
 * requirement was never *CI* — it was **a deterministic Linux renderer**, and
 * that is a container, which runs here.
 *
 * So this script starts `playwright run-server` inside
 * `mcr.microsoft.com/playwright:v<version>-noble`, points the test runner at
 * it, and tears it down. Every pixel a baseline contains is rendered in that
 * image; nothing is rendered by the host.
 *
 * Measured on this repo before any of it was written (an aarch64 host,
 * image `v1.60.0-noble`): the same screen captured four times across two
 * separate containers produced four byte-identical PNGs — same sha256, not
 * "within tolerance". That is the claim the whole approach rests on, and it
 * is why `expect.toHaveScreenshot` runs at `maxDiffPixels: 0`.
 *
 * Three decisions worth knowing:
 *
 * 1. **The host's `node_modules/playwright` is mounted into the container**
 *    rather than installed there with `npx playwright@<version>`. It is the
 *    same package by construction, so the client and the server can never
 *    disagree about their version, and a run needs no npm registry.
 * 2. **The browser reaches the stack through the client, not through Docker
 *    networking.** `exposeNetwork: '<loopback>'` (set in
 *    `playwright.visual.config.ts`) tunnels the container's requests for
 *    `localhost` back out to this machine. That is not only simpler than a
 *    compose network — it is the only arrangement where the address the
 *    browser uses is the `localhost:<port>` this checkout publishes the app
 *    on, which is what the SPA is built against and what its session cookie
 *    is scoped to.
 * 3. **The container's published port is chosen by Docker, and its name
 *    carries a digest of this checkout's path.** Both so two worktrees can
 *    run the gate at the same time — the same reason `scripts/dev-db.ts`
 *    gives a worktree its own database.
 *
 * This script does *not* boot the app stack. Same contract as `bun run
 * shots`: `bun dev:stack` first. A harness that silently boots four services
 * is a harness whose first run takes ten minutes for reasons it never
 * explains.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { isPrimaryCheckout, resolveStackPorts } from '../../../scripts/lib/worktree';

const E2E_ROOT = resolve(import.meta.dir, '..');
const REPO_ROOT = resolve(E2E_ROOT, '../..');

/**
 * Where this checkout's stack is, the same way `scripts/run.ts` resolves it
 * (SC-491, SC-495).
 *
 * `resolveStackPorts` rather than `stackPorts`, so a `<SERVICE>_HOST_PORT` the
 * operator set to escape a slot collision moves this harness with the stack
 * (SC-500). An override honoured by `dev:stack` alone would leave this gate
 * photographing whatever took the old port.
 *
 * The fixtures default to `localhost:5173` and `localhost:3011`, which are the
 * PRIMARY checkout's published ports — so from a linked worktree this harness
 * did not fail to find a stack, it found *somebody else's*, signed in against
 * it and seeded a portfolio into the database they were working in. Deriving
 * the ports here is what makes "the stack this run talks to is the one this
 * worktree started" true rather than incidental.
 */
const PORTS = resolveStackPorts(REPO_ROOT, isPrimaryCheckout(REPO_ROOT));
const STACK_ENV: Record<string, string> = {
  PLAYWRIGHT_BASE_URL:
    process.env.PLAYWRIGHT_BASE_URL ?? `http://localhost:${PORTS.FRONTEND_HOST_PORT}`,
  API_BASE_URL: process.env.API_BASE_URL ?? `http://localhost:${PORTS.API_HOST_PORT}`,
  MAILPIT_URL: process.env.MAILPIT_URL ?? `http://localhost:${PORTS.MAILPIT_UI_HOST_PORT}`,
};

const USAGE = `bun run visual [options]

  --update        regenerate the baselines instead of asserting against them
  --screen=<name> run one screen (see visual/screens.ts for the names)
  --keep-server   leave the browser container running after the run
`;

/**
 * The image tag has to match the client exactly — Playwright refuses to
 * connect across a version mismatch — so it is read from the package that is
 * actually installed rather than from the range in package.json.
 */
function playwrightVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require('playwright-core/package.json') as { version: string };
  return pkg.version;
}

/** Same shape as `scripts/dev-db.ts` names a database: readable half so
 *  `docker ps` is navigable, digest so two worktrees never collide. */
function containerName(): string {
  const leaf = basename(REPO_ROOT);
  const label = (leaf === 'scani' ? basename(dirname(REPO_ROOT)) : leaf)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  const digest = createHash('sha256').update(REPO_ROOT).digest('hex').slice(0, 8);
  return `scani-visual-${label ? `${label}-` : ''}${digest}`;
}

function docker(args: string[], stdio: 'pipe' | 'inherit' = 'pipe') {
  return spawnSync('docker', args, { stdio, encoding: 'utf8' });
}

function assertDocker(): void {
  const probe = docker(['version', '--format', '{{.Server.Version}}']);
  if (probe.status !== 0) {
    throw new Error(
      'Docker is not available. The visual gate renders in the Playwright ' +
        'container by design — there is no host fallback, because a baseline ' +
        'rendered on macOS is one nothing else can reproduce.\n' +
        (probe.stderr ?? '').trim()
    );
  }
}

function ensureImage(image: string): void {
  if (docker(['image', 'inspect', image]).status === 0) return;
  // intentional: this is a multi-gigabyte download and silence would read as a hang
  console.log(`Pulling ${image} (first run only, ~2 GB)…`);
  if (docker(['pull', image], 'inherit').status !== 0) {
    throw new Error(`Failed to pull ${image}`);
  }
}

function startServer(image: string, name: string): { ws: string; stop: () => void } {
  docker(['rm', '-f', name]);
  const started = docker([
    'run',
    '-d',
    '--rm',
    '--init',
    '--name',
    name,
    '--user',
    'pwuser',
    // Port 0 lets Docker pick, so two worktrees can hold the gate at once.
    '-p',
    '127.0.0.1:0:3000',
    '-v',
    `${REPO_ROOT}/node_modules:/pw/node_modules:ro`,
    image,
    'node',
    '/pw/node_modules/playwright/cli.js',
    'run-server',
    '--port',
    '3000',
    '--host',
    '0.0.0.0',
  ]);
  if (started.status !== 0) {
    throw new Error(`Failed to start ${name}:\n${(started.stderr ?? '').trim()}`);
  }

  const stop = () => {
    docker(['rm', '-f', name]);
  };

  try {
    const mapped = docker(['port', name, '3000/tcp']);
    if (mapped.status !== 0) throw new Error((mapped.stderr ?? '').trim());
    // `docker port` prints one line per binding; we published exactly one.
    const port = mapped.stdout.trim().split('\n')[0]?.split(':').pop();
    if (!port) throw new Error(`could not read the published port from "${mapped.stdout.trim()}"`);
    return { ws: `ws://127.0.0.1:${port}/`, stop };
  } catch (err) {
    stop();
    throw new Error(`Failed to read ${name}'s published port: ${(err as Error).message}`);
  }
}

async function waitForServer(ws: string, timeoutMs = 60_000): Promise<void> {
  const url = ws.replace(/^ws:/, 'http:');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      // `run-server` answers a plain GET with an HTTP 400 (it wants a
      // websocket upgrade). Any answer at all means it is listening.
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return;
    } catch {
      await Bun.sleep(250);
    }
  }
  throw new Error(`Browser container never started listening on ${ws}`);
}

const argv = process.argv.slice(2);
if (argv.includes('--help')) {
  // intentional: this is the CLI's help output
  console.log(USAGE);
  process.exit(0);
}

const update = argv.includes('--update');
const keepServer = argv.includes('--keep-server');
const screen = argv.find((arg) => arg.startsWith('--screen='))?.slice('--screen='.length);

assertDocker();
const image = `mcr.microsoft.com/playwright:v${playwrightVersion()}-noble`;
ensureImage(image);

const name = containerName();
const { ws, stop } = startServer(image, name);
let status = 1;
try {
  await waitForServer(ws);
  // intentional: names the renderer every baseline in this run was produced by,
  // and the stack it is pointed at — see PORTS above for why that is not noise
  console.log(`Rendering in ${image} (${name}) against ${STACK_ENV.PLAYWRIGHT_BASE_URL}`);

  status =
    spawnSync(
      'bunx',
      [
        'playwright',
        'test',
        '--config=playwright.visual.config.ts',
        ...(update ? ['--update-snapshots'] : []),
        ...(screen ? ['--grep', screen] : []),
      ],
      { stdio: 'inherit', cwd: E2E_ROOT, env: { ...process.env, ...STACK_ENV, PW_VISUAL_WS: ws } }
    ).status ?? 1;

  if (update && status === 0) {
    // intentional: the discipline this harness is worth nothing without
    console.log(
      '\nBaselines regenerated. Review them as an image diff in the PR — they are ' +
        'migrations, not build output.'
    );
  }
} finally {
  if (keepServer) {
    // intentional: the operator asked for it and now owns the cleanup
    console.log(
      `Browser container ${name} left running (${ws}). \`docker rm -f ${name}\` when done.`
    );
  } else {
    stop();
  }
}

process.exit(status);
