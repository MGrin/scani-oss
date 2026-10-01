import { loadCloudClientConfig } from '@scani/cloud-client';
import {
  checkIndexDrift,
  checkSchemaDrift,
  db,
  describeIndexDrift,
  describeSchemaDrift,
} from '@scani/db';
import { AIRouter } from '@scani/domain/services';
import { ProviderCredentialReport } from '@scani/providers/core/credential-report';
import { pingWithin, type RedisReachability } from '@scani/rate-limiter';
import { StorageService } from '@scani/storage';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { Container } from 'typedi';
import { aiHealthCheck } from '../../lib/ai-health';

export interface DeepCheckDeps {
  redis: Redis;
  redisPingTimeoutMs: number;
  redisReachability: { current: () => RedisReachability };
  diagnosticsToken: string | undefined;
}

export interface DeepHealth {
  status: 'ok' | 'degraded';
  checks: Record<
    string,
    { ok: boolean; latencyMs?: number; error?: string; nameResolutionFailure?: boolean }
  >;
  indexes: { status: 'clean' | 'drift' | 'unread'; latencyMs?: number; detail?: string };
  providerCredentials: ReturnType<ProviderCredentialReport['healthPayload']>;
}

/**
 * Everything `/health/deep` reports, without the HTTP framing: the route maps
 * `status` to 200/503 and stamps the body.
 */
export async function runDeepChecks(deps: DeepCheckDeps): Promise<DeepHealth> {
  const checks: Record<
    string,
    { ok: boolean; latencyMs?: number; error?: string; nameResolutionFailure?: boolean }
  > = {};

  try {
    const t0 = performance.now();
    await db.execute(sql`SELECT 1`);
    checks.db = { ok: true, latencyMs: Math.round(performance.now() - t0) };
  } catch (err) {
    checks.db = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  // SC-480. `SELECT 1` above proves a connection, and proves nothing about
  // the schema on the other end of it: it names no column of any table the
  // deploy just changed, so a code/schema mismatch is invisible to it BY
  // CONSTRUCTION. On 2026-08-20 a deploy that omitted the `migrate` target
  // shipped an api selecting `users.cost_basis_method` against a database
  // without it; this endpoint answered 200, the deploy smoke passed, and
  // sign-in — the one flow that reads `users` by email — failed for six
  // hours. This is the check that would have failed instead.
  //
  // Only run when the connection is up: against an unreachable database it
  // reports every table missing, which reads as catastrophic drift and is
  // really just `checks.db` again, said louder.
  if (checks.db.ok) {
    try {
      const drift = await checkSchemaDrift();
      checks.schema = drift.ok
        ? { ok: true, latencyMs: drift.latencyMs }
        : { ok: false, latencyMs: drift.latencyMs, error: describeSchemaDrift(drift) };
    } catch (err) {
      checks.schema = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // SC-946. Index drift, both directions and full definitions — REPORTED,
  // never gated, and not one of `checks`, for the reason given at
  // `providerCredentials` below. The comparison was proven clean against a
  // freshly migrated database, and production may carry an index no
  // migration made; gating on it before a production reading would 503 the
  // next deploy on a difference nobody has looked at. It moves into `checks`
  // once a production reading shows it clean.
  let indexes: { status: 'clean' | 'drift' | 'unread'; latencyMs?: number; detail?: string };
  if (!checks.db.ok) {
    indexes = { status: 'unread', detail: 'the database check failed' };
  } else {
    try {
      const report = await checkIndexDrift();
      indexes = report.ok
        ? { status: 'clean', latencyMs: report.latencyMs }
        : { status: 'drift', latencyMs: report.latencyMs, detail: describeIndexDrift(report) };
    } catch (err) {
      indexes = { status: 'unread', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  const tRedis = performance.now();
  try {
    // BOUNDED, and that bound is the whole point (SC-294).
    //
    // ioredis queues a command issued while the connection is down and
    // resolves it whenever the connection comes back — which, for a machine
    // whose Redis host does not resolve, is never. So this `await` used to
    // hang until Fly's proxy gave up at ~31s and returned a 502 with no
    // body at all.
    //
    // That is why `redisReachability` — the field added directly below,
    // whose entire job is to say WHICH kind of unreachable this is — had
    // never once been read during an occurrence. The deploy smoke fetches
    // its diagnostic body with `curl --max-time 10`, so it got an empty
    // string and reported `exit=28`. The endpoint carrying the diagnosis
    // could not deliver it during the exact failure it describes.
    //
    // Two seconds is chosen against ioredis's own retry cadence: the
    // default `retryStrategy` tops out at one attempt every 2000ms, so a
    // ping that has not been answered within one full retry interval is not
    // waiting on a slow Redis, it is waiting on one that is not there.
    // Healthy production latency on this check is 1ms.
    const reply = await pingWithin(deps.redis, deps.redisPingTimeoutMs);
    checks.redis = {
      ok: reply === 'PONG',
      latencyMs: Math.round(performance.now() - tRedis),
      ...(reply !== 'PONG' ? { error: `unexpected reply ${reply}` } : {}),
    };
  } catch (err) {
    checks.redis = {
      ok: false,
      latencyMs: Math.round(performance.now() - tRedis),
      error: err instanceof Error ? err.message : String(err),
    };
  }

  // SC-225. `ping()` above answers "can I reach Redis right now"; this
  // answers "how long have I not been able to, and is it the kind that
  // recovers". One machine sat on an unresolvable name for three hours
  // while the probe simply said `ok: false`, which reads the same as a
  // worker deploy in progress. `nameResolutionFailure` is the difference:
  // ioredis re-resolves every ~2s forever and will keep getting the same
  // answer, so that one needs the machine replaced rather than waiting.
  //
  // Gated on the ping deliberately. ioredis emits `error` for things that do
  // NOT close the socket, and those are never followed by a `ready` to clear
  // the tracker — so a latched tracker on its own would 503 this endpoint
  // forever against a perfectly healthy Redis. The ping is the authority on
  // "can I reach it now"; the tracker only ever explains "for how long, and
  // is it the kind that recovers".
  const reachability = deps.redisReachability.current();
  if (reachability.state === 'unreachable' && checks.redis?.ok !== true) {
    checks.redisReachability = {
      ok: false,
      nameResolutionFailure: reachability.nameResolutionFailure,
      error: reachability.nameResolutionFailure
        ? `host does not resolve from this machine for ${reachability.unreachableForMs}ms (${reachability.consecutiveErrors} attempts) — will not self-heal`
        : `unreachable for ${reachability.unreachableForMs}ms (${reachability.consecutiveErrors} attempts): ${reachability.lastError}`,
    };
  }

  try {
    // In cloud mode R2 credentials live on the data-provider, not here.
    // Proxy the check through `${SCANI_CLOUD_URL}/health/r2` so a real
    // storage outage shows up as `r2.ok=false` instead of being masked
    // by a hard-coded ok. Otherwise run the in-process HEAD probe.
    const storageConfig = loadCloudClientConfig();
    const cloudUrl = ['1', '2'].includes(storageConfig.SCANI_DEPLOYMENT_TIER ?? '')
      ? undefined
      : storageConfig.SCANI_CLOUD_URL;
    if (cloudUrl) {
      const t0 = performance.now();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3_000);
      try {
        const res = await fetch(`${cloudUrl.replace(/\/$/, '')}/health/r2`, {
          signal: ctrl.signal,
          headers: {
            accept: 'application/json',
            ...(deps.diagnosticsToken ? { authorization: `Bearer ${deps.diagnosticsToken}` } : {}),
          },
        });
        const latencyMs = Math.round(performance.now() - t0);
        if (res.ok) {
          const upstream = (await res.json().catch(() => ({}))) as {
            ok?: boolean;
            latencyMs?: number;
            error?: string;
          };
          checks.r2 = upstream.ok
            ? { ok: true, latencyMs: upstream.latencyMs ?? latencyMs }
            : { ok: false, error: upstream.error ?? 'data-provider reported r2 unhealthy' };
        } else {
          checks.r2 = { ok: false, error: `data-provider /health/r2 returned ${res.status}` };
        }
      } finally {
        clearTimeout(timer);
      }
    } else {
      checks.r2 = await Container.get(StorageService).healthCheck();
    }
  } catch (err) {
    checks.r2 = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    checks.ai = aiHealthCheck(await Container.get(AIRouter).getAvailability());
  } catch (err) {
    checks.ai = { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  // SC-536. Reported, never gated. All three backend apps boot the
  // provider registry in `direct` mode, so a missing platform key
  // degrades THIS app — silently: Finnhub returns null for every equity
  // price, CoinGecko drops to the public tier, Etherscan goes
  // unauthenticated, OpenAI throws on every parse. Nothing fails at boot,
  // so an operator who followed the docs sees a green service and finds
  // out weeks later, from the data.
  //
  // It is NOT one of `checks` above, and that is deliberate: `checks`
  // decides the 200/503, and an unkeyed provider is a configuration
  // choice rather than an outage. Folding it in would 503 every dev and
  // self-host deployment that has not bought a CoinGecko Pro plan, and an
  // endpoint that is always red is one nobody reads.
  return {
    status: allOk ? 'ok' : 'degraded',
    checks,
    indexes,
    providerCredentials: Container.get(ProviderCredentialReport).healthPayload(),
  };
}
