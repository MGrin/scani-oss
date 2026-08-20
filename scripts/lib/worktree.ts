/**
 * One identity for a checkout — its name and its host ports — used by every
 * per-worktree thing this repo starts.
 *
 * WHY (SC-491). Two worktrees could not run `bun dev:stack` at once, and the
 * loud half of that was the smaller half: a port bind error names the port and
 * stops. The dangerous half is silent. Compose identifies a container by
 * project + service, the project name defaults to the directory leaf, and
 * every bb worktree's leaf is `scani` — so a second `up` did not conflict with
 * the first, it ADOPTED and recreated its containers. A worktree's stack
 * restarted the main checkout's Postgres out from under a running session.
 *
 * So the isolator is the compose PROJECT NAME, and the ports only decide
 * whether the collision is loud. Both are derived here, from the same digest,
 * so a checkout's database, its containers and its ports carry one suffix and
 * a person can tell which stack is which.
 *
 * The readable half is first so `docker ps` and `\l` in psql are navigable;
 * the digest is over the ABSOLUTE path, so two checkouts whose directories
 * happen to share a name cannot collide.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';

export interface WorktreeIdentity {
  /** Lowercase, `_`-separated, ≤24 chars. Empty when the path has no usable name. */
  label: string;
  /** First 8 hex chars of sha256 over the absolute path. */
  digest: string;
}

export function worktreeIdentity(worktreePath: string): WorktreeIdentity {
  const normalized = worktreePath.replace(/\/+$/, '');
  // `.../env_armtptz6ca/scani` and `.../mgrin/scani` both end in `scani`, so
  // the parent is what carries the meaning in a bb worktree.
  const leaf = basename(normalized);
  const parent = basename(dirname(normalized));
  const label = (leaf === 'scani' ? parent : leaf)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 8);
  return { label, digest };
}

/** `<label>_<digest>`, or just the digest when the path yielded no label. */
export function worktreeSuffix(worktreePath: string): string {
  const { label, digest } = worktreeIdentity(worktreePath);
  return label ? `${label}_${digest}` : digest;
}

/**
 * The database this worktree owns (SC-429). Here, with the rest of a
 * checkout's identity, so a caller can name it without importing a module that
 * needs `postgres` installed — a fresh worktree should be able to start its
 * stack before anything else has run (SC-474).
 */
export function devDatabaseName(worktreePath: string): string {
  return `scani_dev_${worktreeSuffix(worktreePath)}`;
}

/**
 * The compose project name for a checkout. Legal per compose's own rule
 * (`[a-z0-9][a-z0-9_-]*`) and the same suffix the database carries.
 */
export function composeProjectName(worktreePath: string): string {
  return `scani_${worktreeSuffix(worktreePath)}`;
}

export interface StackService {
  /** Env var `docker-compose.yml` reads for this published port. */
  env: string;
  /** The host port the documented default uses. */
  base: number;
  /** What to call it when printing where the stack is reachable. */
  label: string;
  scheme: 'http' | 'tcp';
}

/**
 * Every host port `docker-compose.yml` publishes. A service added to that file
 * without a line here keeps a fixed port, which is how two checkouts end up
 * publishing onto the same one.
 */
export const STACK_SERVICES: readonly StackService[] = [
  { env: 'FRONTEND_HOST_PORT', base: 5173, label: 'app', scheme: 'http' },
  { env: 'LANDING_HOST_PORT', base: 5174, label: 'landing', scheme: 'http' },
  { env: 'ADMIN_HOST_PORT', base: 5175, label: 'admin', scheme: 'http' },
  { env: 'CLOUD_HOST_PORT', base: 5176, label: 'cloud', scheme: 'http' },
  { env: 'API_HOST_PORT', base: 3011, label: 'api', scheme: 'http' },
  { env: 'DATA_PROVIDER_HOST_PORT', base: 8082, label: 'data-provider', scheme: 'http' },
  { env: 'MAILPIT_UI_HOST_PORT', base: 8026, label: 'mailpit', scheme: 'http' },
  { env: 'MINIO_CONSOLE_HOST_PORT', base: 9001, label: 'minio console', scheme: 'http' },
  { env: 'MINIO_API_HOST_PORT', base: 9000, label: 'minio s3', scheme: 'http' },
  { env: 'MAILPIT_SMTP_HOST_PORT', base: 1026, label: 'mailpit smtp', scheme: 'tcp' },
  { env: 'POSTGRES_HOST_PORT', base: 5433, label: 'postgres', scheme: 'tcp' },
  { env: 'REDIS_HOST_PORT', base: 6380, label: 'redis', scheme: 'tcp' },
];

/**
 * Offsets are multiples of 100 and stop at 2000 because no two base ports
 * above differ by a multiple of 100 inside that range — so one worktree's
 * published port can never land on another worktree's, whatever slots the two
 * digests picked. A step small enough to break that (20 would: 5433 - 5173 is
 * 260) buys nothing and reintroduces the bug in a shape nobody would look for.
 * The test pins it exhaustively.
 */
export const OFFSET_STEP = 100;
export const OFFSET_SLOTS = 20;

/**
 * The primary checkout keeps the documented ports — `localhost:5173` is in the
 * README, in CLAUDE.md, in the e2e defaults and in muscle memory, and moving it
 * everywhere would trade one worktree's problem for everyone's. Linked
 * worktrees, which is what a bb environment is, get a slot of their own.
 *
 * Two worktrees can still draw the same slot (20 of them); that collides
 * loudly on a port bind, and the override below is the answer. Adoption — the
 * failure that cost something — is prevented by the project name regardless.
 */
export function portOffset(worktreePath: string, isPrimary: boolean): number {
  if (isPrimary) return 0;
  const { digest } = worktreeIdentity(worktreePath);
  return ((Number.parseInt(digest, 16) % OFFSET_SLOTS) + 1) * OFFSET_STEP;
}

/**
 * `true` when this path is the repository's main working tree. A linked
 * worktree's `--git-dir` sits under the main one's `--git-common-dir`; they are
 * the same directory only in the primary checkout. A path that is not a git
 * repository at all (an unpacked tarball, a self-host copy) counts as primary,
 * because then there is nothing to be a second copy of.
 */
export function isPrimaryCheckout(worktreePath: string): boolean {
  const probe = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'],
    {
      cwd: worktreePath,
      encoding: 'utf8',
    }
  );
  if (probe.status !== 0) return true;
  const [gitDir, commonDir] = probe.stdout.trim().split('\n');
  if (!gitDir || !commonDir) return true;
  return resolve(gitDir) === resolve(commonDir);
}

/** Published host port per service env var, for this checkout. */
export function stackPorts(
  worktreePath: string,
  isPrimary = isPrimaryCheckout(worktreePath)
): Record<string, number> {
  const offset = portOffset(worktreePath, isPrimary);
  return Object.fromEntries(STACK_SERVICES.map((s) => [s.env, s.base + offset]));
}

/**
 * The compose project for a run of the E2E suite (SC-493).
 *
 * Deliberately NOT the worktree's dev-stack project. `apps/e2e/scripts/run.ts`
 * tears its stack down with `down -v`, and `-v` removes volumes — so a project
 * shared with `bun dev:stack` would make the end of a test run delete the
 * database somebody is developing against. Its own name is what makes "the
 * teardown can only remove what this run created" true by construction rather
 * than by whichever mode the runner happened to take.
 *
 * The ports stay `stackPorts` above: the suite is meant to reuse an
 * already-running stack when there is one (`run.ts` Mode A), and it finds that
 * stack by probing the port this worktree publishes on.
 */
export function e2eProjectName(worktreePath: string): string {
  return `${composeProjectName(worktreePath)}_e2e`;
}
