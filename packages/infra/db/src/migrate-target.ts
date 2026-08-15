/**
 * Identifying — and gating — the database a migration run is about to rewrite.
 *
 * `bun run db:migrate` applies every pending migration in the current working
 * tree to whatever `DATABASE_URL` happens to be exported. That was safe while
 * migrations only ever ran from a single-purpose CI runner; it is not safe now
 * that production deploys run from a laptop whose shell may still be holding a
 * production connection string from an earlier step.
 *
 * The opt-in is therefore a command-line argument that NAMES the target host,
 * rather than an environment variable or a boolean:
 *
 *   - argv is per-invocation, so unlike an env var it cannot be left armed in a
 *     shell — which is the exact failure being prevented.
 *   - naming the host makes it a match rather than a yes: if the operator
 *     believes they are pointed at a scratch database and `DATABASE_URL` says
 *     otherwise, the mismatch refuses instead of proceeding.
 *
 * Loopback targets skip the gate entirely — scratch databases get created and
 * migrated dozens of times a day, and friction there would be paid constantly
 * to protect nothing.
 */

export type MigrationTarget = {
  host: string;
  port: string;
  database: string;
  user: string;
};

export function describeTarget(databaseUrl: string): MigrationTarget | null {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  return {
    host: url.hostname,
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || '(default)',
    user: url.username ? decodeURIComponent(url.username) : '(default)',
  };
}

export function formatTarget(target: MigrationTarget): string {
  return `${target.user}@${target.host}:${target.port}/${target.database}`;
}

/**
 * Loopback only. A bare single-label hostname (`postgres`, as docker-compose
 * resolves it) deliberately does NOT count: the compose files name it on the
 * command line instead, so each file documents the database it rewrites.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === 'host.docker.internal') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The whole of `process.argv` is scanned rather than `slice(2)`: under
 * `bun --compile` (Dockerfile.migrate) the leading entries differ from those of
 * a source run, and neither form can produce a literal `--allow-remote`.
 *
 * Returns `null` when the flag is absent, and `''` when it is present with no
 * value — which never matches a host, so it refuses like any other mismatch.
 */
export function parseAllowRemote(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--allow-remote') return argv[i + 1] ?? '';
    if (arg?.startsWith('--allow-remote=')) return arg.slice('--allow-remote='.length);
  }
  return null;
}

export type TargetDecision =
  | { allowed: true; reason: 'loopback' | 'named' }
  | { allowed: false; requested: string | null };

export function decideTarget(target: MigrationTarget, argv: readonly string[]): TargetDecision {
  if (isLoopbackHost(target.host)) return { allowed: true, reason: 'loopback' };
  const requested = parseAllowRemote(argv);
  if (requested !== null && requested === target.host) return { allowed: true, reason: 'named' };
  return { allowed: false, requested };
}

export function refusalMessage(target: MigrationTarget, requested: string | null): string {
  const lines = [
    '❌ Refusing to migrate a non-local database.',
    '',
    `   Target: ${formatTarget(target)}`,
  ];
  if (requested !== null) {
    lines.push(`   --allow-remote ${requested || '<missing value>'} does not name that host.`);
  }
  lines.push(
    '',
    '   This applies every pending migration in the current working tree.',
    '   To proceed, name the host on the command line:',
    '',
    `     bun run db:migrate -- --allow-remote ${target.host}`,
    '',
    '   Production deploys should go through `scripts/deploy-local.sh migrate`,',
    '   which resolves the URI from Neon and passes this for you.'
  );
  return lines.join('\n');
}
