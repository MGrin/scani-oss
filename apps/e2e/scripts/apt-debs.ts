#!/usr/bin/env bun

// SC-1764. `playwright install --with-deps` downloads ~189 system packages
// from the runner's Ubuntu mirror on every CI run, and on a slow mirror that
// download outlasted the install step. `.github/workflows/ci.yml` restores and
// saves `~/apt-debs` around the install; this moves the .deb files between that
// folder and apt's archive, where apt looks before downloading.
//
//   bun apps/e2e/scripts/apt-debs.ts seed      before the install
//   bun apps/e2e/scripts/apt-debs.ts collect   after it; prints kept=<n> on stdout

import { copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';

const ARCHIVE = '/var/cache/apt/archives';
const KEPT = join(homedir(), 'apt-debs');
// Bounded waits make a stalled mirror fail and retry on the next one in the
// runner's mirror list, rather than hang until the step's timeout.
const APT_CONF = [
  'APT::Keep-Downloaded-Packages "true";',
  'Acquire::http::Timeout "30";',
  'Acquire::https::Timeout "30";',
  'Acquire::Retries "3";',
  '',
].join('\n');

function debs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.deb'));
  } catch {
    return [];
  }
}

const mode = process.argv[2];

if (mode === 'seed') {
  const conf = join(tmpdir(), '99-e2e-install');
  writeFileSync(conf, APT_CONF);
  await $`sudo cp ${conf} /etc/apt/apt.conf.d/99-e2e-install`;
  const restored = debs(KEPT).map((name) => join(KEPT, name));
  if (restored.length > 0) await $`sudo cp ${restored} ${ARCHIVE}/`;
  console.log(`apt-debs: seeded ${restored.length} package(s) into ${ARCHIVE}`);
} else if (mode === 'collect') {
  mkdirSync(KEPT, { recursive: true });
  const downloaded = debs(ARCHIVE);
  for (const name of downloaded) copyFileSync(join(ARCHIVE, name), join(KEPT, name));
  const kept = debs(KEPT).length;
  console.error(`apt-debs: kept ${kept} package(s) in ${KEPT}`);
  console.log(`kept=${kept}`);
} else {
  console.error('usage: bun apps/e2e/scripts/apt-debs.ts seed|collect');
  process.exit(2);
}
