#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEFAULT_SHOT_DEVICES, VIEWPORTS, type ViewportName } from '../fixtures/devices';
import { shotOptions } from '../fixtures/shots-setup';

const E2E_ROOT = resolve(import.meta.dir, '..');

const USAGE = `bun run shots [options]

  --devices=iphone,ipad   viewports to capture (default: ${DEFAULT_SHOT_DEVICES.join(',')})
                          known: ${VIEWPORTS.map((v) => v.name).join(', ')}
  --routes=/,/holdings    app routes to walk (default: see fixtures/shots-setup.ts)
  --out=shots             output directory, relative to apps/e2e
  --viewport              capture the visible viewport only (default: full page)
  --settle=1200           milliseconds to wait after load before the shot
  --fresh                 sign in as a new user and reseed instead of reusing
`;

interface Args {
  devices: ViewportName[];
  env: Record<string, string>;
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) flags.add(body);
    else values.set(body.slice(0, eq), body.slice(eq + 1));
  }

  if (flags.has('help')) {
    // intentional: this is the CLI's help output
    console.log(USAGE);
    process.exit(0);
  }

  const known = new Set<string>(VIEWPORTS.map((v) => v.name));
  const devices = (values
    .get('devices')
    ?.split(',')
    .map((name) => name.trim())
    .filter(Boolean) ?? DEFAULT_SHOT_DEVICES) as ViewportName[];
  for (const name of devices) {
    if (!known.has(name)) {
      throw new Error(`Unknown --devices entry "${name}"; known: ${[...known].join(', ')}`);
    }
  }

  const env: Record<string, string> = {};
  const routes = values.get('routes');
  if (routes) env.SHOT_ROUTES = routes;
  const out = values.get('out');
  if (out) env.SHOT_OUT = out;
  const settle = values.get('settle');
  if (settle) env.SHOT_SETTLE_MS = settle;
  if (flags.has('viewport')) env.SHOT_VIEWPORT_ONLY = '1';
  if (flags.has('fresh')) env.SHOT_FRESH = '1';

  return { devices, env };
}

/**
 * Thin wrapper: the capture itself runs through the Playwright runner rather
 * than driving the browser from this process. That is not ceremony — under Bun,
 * `page.request`'s Set-Cookie parsing throws on the relative URLs Better-Auth
 * returns, which breaks the sign-in fixture. The runner executes under Node,
 * where the same fixtures already work for the whole spec suite.
 */
const args = parseArgs(process.argv.slice(2));
const opts = shotOptions({ ...process.env, ...args.env });

await rm(opts.outDir, { recursive: true, force: true });

const status =
  spawnSync(
    'bunx',
    [
      'playwright',
      'test',
      '--config=playwright.shots.config.ts',
      ...args.devices.flatMap((device) => ['--project', device]),
    ],
    { stdio: 'inherit', cwd: E2E_ROOT, env: { ...process.env, ...args.env } }
  ).status ?? 1;

if (status === 0) {
  // intentional: tells the operator (or agent) where to look
  console.log(`\nScreenshots in ${opts.outDir}`);
}
process.exit(status);
