import Redis from 'ioredis';

// The dev Redis is published on a host port by `docker-compose.yml`, so talk to
// it over that port with the client this repo already depends on.
//
// The previous implementation shelled out to `docker exec <name> redis-cli`,
// which coupled the suite to three things it has no business knowing: that a
// container runtime is involved at all, what that container is called, and that
// `redis-cli` is installed inside the image. The name was the one that broke —
// it was hardcoded to `scani-redis`, which the downstream tree sets via
// `container_name` and this one does not, so four specs failed with
// `No such container` on every CI run.
//
// A host port is a weaker coupling than a container name: it is declared in the
// same compose file the suite starts, and `REDIS_URL` overrides it for a stack
// started some other way.
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';

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
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: true });
  try {
    await redis.connect();
    const all: string[] = [];
    for (const pattern of patterns) {
      // SCAN rather than KEYS: same reason the CLI form used `--scan`, which is
      // a SCAN loop under the covers — KEYS blocks the server for the whole
      // keyspace, and this runs before a lot of specs.
      let cursor = '0';
      do {
        const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        all.push(...batch);
      } while (cursor !== '0');
    }
    if (all.length > 0) await redis.del(...all);
  } finally {
    redis.disconnect();
  }
}
