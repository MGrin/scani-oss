#!/usr/bin/env node

/**
 * Writes a fresh `public/version.json` at build time. Polled by the
 * shared `useAppUpdate` hook (packages/frontend/ui/src/hooks/useAppUpdate.ts)
 * to detect when a new deploy is live and surface the blue update banner.
 *
 * Mirrors what `apps/frontend/{app,cloud}/plugins/vite-version.ts` does for
 * the Vite SPAs — Next.js doesn't have a one-line plugin equivalent, so we
 * run a small script from `prebuild`.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = join(__dirname, '..', 'public', 'version.json');

const version = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const buildTime = new Date().toISOString();

writeFileSync(target, JSON.stringify({ version, buildTime }));
console.log(`✓ wrote ${target} (version=${version})`);
