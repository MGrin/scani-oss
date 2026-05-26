import { spawn } from 'node:child_process';

function getContainerName(): string {
  return process.env.REDIS_CONTAINER ?? 'mgrin-e2e-suite-redis-1';
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
  // The namespace is `rl:signup:<ip>` (see createSignupLimiter).
  const keys = await redisCli(['--scan', '--pattern', 'rl:signup:*']);
  if (!keys) return;
  const lines = keys.split('\n').filter((l) => l.length > 0);
  if (lines.length === 0) return;
  await redisCli(['DEL', ...lines]);
}
