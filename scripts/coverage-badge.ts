#!/usr/bin/env bun
// Reads coverage/lcov.info, computes line coverage %, writes
// coverage/badge.json in the shields.io endpoint format consumed by
// `Schneegans/dynamic-badges-action`. CI then uploads that JSON to a
// gist; README points at the gist URL via shields.io's `endpoint=` query
// parameter.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LCOV_PATH = resolve(import.meta.dir, '..', 'coverage', 'lcov.info');
const OUT_PATH = resolve(import.meta.dir, '..', 'coverage', 'badge.json');

let lf = 0;
let lh = 0;
for (const line of readFileSync(LCOV_PATH, 'utf8').split('\n')) {
  if (line.startsWith('LF:')) lf += Number.parseInt(line.slice(3), 10);
  else if (line.startsWith('LH:')) lh += Number.parseInt(line.slice(3), 10);
}

if (lf === 0) {
  console.error('coverage-badge: no LF entries found — coverage/lcov.info empty?');
  process.exit(1);
}

const pct = (lh / lf) * 100;
// Color buckets follow the convention used by codecov / coveralls badges.
const color =
  pct >= 90
    ? 'brightgreen'
    : pct >= 75
      ? 'green'
      : pct >= 60
        ? 'yellowgreen'
        : pct >= 45
          ? 'yellow'
          : pct >= 30
            ? 'orange'
            : 'red';

const payload = {
  schemaVersion: 1,
  label: 'coverage',
  message: `${pct.toFixed(1)}%`,
  color,
};

writeFileSync(OUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`coverage: ${lh}/${lf} lines (${pct.toFixed(1)}%) → ${OUT_PATH}`);
