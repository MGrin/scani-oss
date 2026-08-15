import { spawn, spawnSync } from 'node:child_process';

// Ask compose which container is running the `redis` service rather than
// guessing its name. A hardcoded name is a bet on `docker-compose.yml`, and
// that file is pinned per-repo: the downstream tree sets
// `container_name: scani-redis`, this one takes compose's generated
// `<project>-redis-1`. The name that works in one is absent in the other, and
// the failure surfaces as `No such container` in an unrelated account test.
//
// `REDIS_CONTAINER` still wins, for a stack started outside compose.
let cached: string | null = null;

function getContainerName(): string {
  const override = process.env.REDIS_CONTAINER;
  if (override) return override;
  if (cached) return cached;
  const out = spawnSync('docker', ['compose', 'ps', '-q', 'redis'], { encoding: 'utf8' });
  const id = out.stdout?.trim().split('\n')[0] ?? '';
  if (!id) {
    throw new Error(
      'Could not find the compose container for the `redis` service. ' +
        'Is the stack up (`bun dev:stack`)? Set REDIS_CONTAINER to override.'
    );
  }
  cached = id;
  return id;
}

/**
 * Execute a redis command in the dev Redis via `docker exec redis-cli`.
 * Returns stdout (trimmed).
 */
async function redisCli(args: string[]): Promise<string> {
  const container = getContainerName();
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['exec', container, 'redis-cli', ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`redis-cli exited ${code}: ${stderr}`));
      resolve(stdout.trim());
    });
  });
}

/**
 * Flush all per-IP signup/auth rate-limit keys. The API rate-limits
 * OTP/magic-link/sign-in/sign-up at 6 per IP per hour to defend
 * against enumeration. The e2e suite blows through that budget in a
 * single run (multiple auth specs × 2 browser projects). Call this at
 * the start of any spec that issues an auth request so subsequent
 * tests get a fresh window. This is test-only — never invoke from
 * production code.
 */
export async function resetAuthRateLimit(): Promise<void> {
  // Namespaces: `rl:signup:<ip>` (signup/OTP per-IP cap) +
  // `rl:session-revoke:user:<userId>` (per-user revoke cap, 10/min).
  // Both can pollute consecutive specs that exercise auth or sessions.
  const patterns = ['rl:signup:*', 'rl:session-revoke:*'];
  const all: string[] = [];
  for (const pattern of patterns) {
    const keys = await redisCli(['--scan', '--pattern', pattern]);
    if (!keys) continue;
    for (const line of keys.split('\n')) {
      if (line.length > 0) all.push(line);
    }
  }
  if (all.length === 0) return;
  await redisCli(['DEL', ...all]);
}
