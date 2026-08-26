/**
 * `.dockerignore` keeps every `.env` out of every build context (SC-650).
 *
 * ## Why this is a test and not a comment in the file
 *
 * The rule it guards is stated in `.dockerignore` itself and was still got
 * wrong. A bare `.env` matches the CONTEXT ROOT only, because Docker matches a
 * pattern against a whole relative path. `node_modules`, `dist`, `.next` and
 * `coverage` each got their twin; `.git`, `.env` and `.env.*` did not. Since
 * `scripts/sync-env.ts` writes a per-app `.env` (mode 600) into every app
 * directory, all seven reached the build context of all five images.
 *
 * Measured against the REAL `apps/backend/api/Dockerfile`, no override, before
 * the fix: `/app/apps/backend/api/.env` was present in the build stage. The
 * root `.env` was correctly absent in that same run — the control, and the
 * reason the gap read as a working ignore file rather than a broken one.
 *
 * ## The oracle, and why `isExcluded` is not one
 *
 * Docker is the oracle. Every expectation in `CASES` was taken from a real
 * `docker build --output type=local` against this repo on 2026-08-26: a
 * `FROM scratch` + `COPY <path>` probe, where a build failing with
 * `"<path>": not found` means excluded and one that exports the file means
 * reachable. Re-take the whole table in one step:
 *
 *   for p in apps/backend/api/.env .env apps/backend/api/.env.example; do
 *     printf 'FROM scratch\nCOPY %s /x\n' "$p" > sc650probe.Dockerfile
 *     docker build -q -f sc650probe.Dockerfile -o type=local,dest=/tmp/o . \
 *       >/dev/null 2>&1 && echo "$p reachable" || echo "$p excluded"
 *   done; rm -f sc650probe.Dockerfile
 *
 * `isExcluded` re-implements the documented subset of Docker's syntax so this
 * runs under `bun run test` with no daemon — a gate that needs Docker is one
 * people stop running. It is a cheap re-check of a recorded measurement, NOT
 * an authority on Docker's behaviour. If it and Docker ever disagree, Docker
 * is right and this file is the bug.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');

function loadPatterns(): string[] {
  return readFileSync(join(REPO_ROOT, '.dockerignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

const DOUBLE_STAR = '@@DOUBLESTAR@@';

/** Docker matches a pattern against the whole slash-joined relative path. */
function toRegExp(pattern: string): RegExp {
  const body = pattern
    .split('/')
    .map((segment) =>
      segment === '**'
        ? DOUBLE_STAR
        : segment
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]')
    )
    .join('/')
    // `**` spans zero or more path segments, so it swallows the `/` beside it.
    .replaceAll(`${DOUBLE_STAR}/`, '(?:.*/)?')
    .replaceAll(DOUBLE_STAR, '.*');
  // A directory pattern also excludes everything beneath it.
  return new RegExp(`^${body}(?:/.*)?$`);
}

/** Docker applies the LAST matching rule, which is what makes `!` work. */
function isExcluded(path: string, patterns: string[]): boolean {
  let excluded = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith('!');
    if (toRegExp(negated ? pattern.slice(1) : pattern).test(path)) excluded = !negated;
  }
  return excluded;
}

/** Every row measured against real Docker on 2026-08-26. See the docblock. */
const CASES: ReadonlyArray<{ path: string; excluded: boolean; why: string }> = [
  // The defect. Every one of these was REACHABLE before the fix.
  { path: 'apps/backend/api/.env', excluded: true, why: 'per-app env, written by sync-env.ts' },
  { path: 'apps/backend/worker/.env', excluded: true, why: 'per-app env' },
  { path: 'apps/backend/data-provider/.env', excluded: true, why: 'per-app env' },
  { path: 'apps/frontend/app/.env', excluded: true, why: 'per-app env, reached by COPY . .' },
  { path: 'apps/frontend/cloud/.env', excluded: true, why: 'per-app env' },
  { path: 'apps/frontend/landing/.env', excluded: true, why: 'per-app env' },
  { path: 'apps/frontend/admin/.env.local', excluded: true, why: 'per-app env, .local variant' },
  { path: 'apps/backend/api/.git', excluded: true, why: 'git metadata at any depth' },
  // Already working before the fix — the control that says the file is not
  // simply excluding everything.
  { path: '.env', excluded: true, why: 'root env, the case that always worked' },
  { path: '.git/config', excluded: true, why: 'root git dir' },
  { path: 'packages/infra/db/node_modules/zod/index.js', excluded: true, why: 'the V3-17 case' },
  // must-be-FOUND. If any of these flips, the fix has broken a build rather
  // than secured one. `.env.example` in particular is deliberately kept.
  { path: '.env.example', excluded: false, why: 'tracked, and the file sync-env.ts reads' },
  { path: 'apps/backend/api/.env.example', excluded: false, why: 'tracked per-app example' },
  { path: 'apps/backend/api/src/index.ts', excluded: false, why: 'the application itself' },
  {
    path: 'packages/business/domain/src/lib/transfer-matching.ts',
    excluded: false,
    why: 'shared code every image copies',
  },
  { path: 'package.json', excluded: false, why: 'the manifest every Dockerfile copies first' },
];

describe('.dockerignore keeps secrets out of every build context (SC-650)', () => {
  const patterns = loadPatterns();

  for (const { path, excluded, why } of CASES) {
    it(`${excluded ? 'excludes' : 'keeps'} ${path} — ${why}`, () => {
      expect(isExcluded(path, patterns)).toBe(excluded);
    });
  }

  it('gives every root-anchored secret rule its `**/` twin', () => {
    // The structural half. A future `.env.production` added without a twin
    // passes every row above — nothing lists it — and fails here.
    const secretRules = patterns.filter(
      (p) => !p.startsWith('!') && !p.startsWith('**/') && /^\.(env|git)/.test(p)
    );
    const missing = secretRules.filter((p) => !patterns.includes(`**/${p}`));
    expect(missing).toEqual([]);
  });
});
