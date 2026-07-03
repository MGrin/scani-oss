import { cached } from '../cache';
import { getEnv } from '../env';
import { type Result, tryCatch } from '../result';
// Queue depths come off the worker-embedded Redis (6PN-only) via the
// backend's HMAC read proxy — Upstash REST no longer sees bull:* keys.
import { redisPipeline } from './queue-redis';

const BASE = 'https://api.upstash.com/v2';

function authHeader(): string {
  const email = getEnv('UPSTASH_EMAIL');
  const key = getEnv('UPSTASH_API_KEY');
  if (!email || !key) throw new Error('UPSTASH_EMAIL / UPSTASH_API_KEY missing');
  return `Basic ${Buffer.from(`${email}:${key}`).toString('base64')}`;
}

async function req<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: authHeader() },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Upstash ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export interface UpstashDb {
  id: string;
  name: string;
  region: string;
  type: string;
  endpoint: string;
  port: number;
  state: string;
  tls: boolean;
  /**
   * Upstash list endpoint reports the disk threshold here (size cap),
   * NOT live usage. We keep it for plan-tier signaling.
   */
  dbSizeBytes: number;
  createdAt: number;
}

export async function getUpstashDatabases(): Promise<Result<UpstashDb[]>> {
  return tryCatch(() =>
    cached('upstash:databases', 30, async () => {
      const list = await req<Array<Record<string, unknown>>>('/redis/databases');
      return list.map((d) => ({
        id: (d.database_id as string) ?? '',
        name: (d.database_name as string) ?? 'unnamed',
        region: (d.region as string) ?? 'unknown',
        type: (d.database_type as string) ?? 'unknown',
        endpoint: (d.endpoint as string) ?? '',
        port: (d.port as number) ?? 0,
        state: (d.state as string) ?? 'unknown',
        tls: Boolean(d.tls),
        dbSizeBytes: (d.db_disk_threshold as number) ?? (d.db_max_size as number) ?? 0,
        createdAt: (d.creation_time as number) ?? 0,
      }));
    })
  );
}

/**
 * Per-database usage from `/redis/stats/<id>`.
 *
 * Earlier versions of this client tried to read usage counters
 * (`db_total_commands`, `db_daily_bandwidth`, etc.) off the
 * `/redis/databases` list response — Upstash doesn't populate those
 * on the list endpoint, so the dashboard rendered zeros. The stats
 * endpoint is the source of truth; everything below comes from there.
 *
 * Upstash field names are inconsistent across plan tiers, so each
 * value reads through a short fallback chain of plausible keys before
 * defaulting to 0. The shape is normalized into clearly-named fields
 * (`monthlyRequests`, `dailyBandwidth`, …) so the page never has to
 * decode Upstash's raw schema again.
 */
export interface UpstashStats {
  /** Month-to-date request count. */
  monthlyRequests: number;
  /** Today's request count (last 24h sample). */
  dailyRequests: number;
  /** Month-to-date egress bytes. */
  monthlyBandwidthBytes: number;
  /** Today's egress bytes. */
  dailyBandwidthBytes: number;
  /** Month-to-date unique connection count (Upstash sums opens). */
  monthlyConnections: number;
  /** Today's unique connection count. */
  dailyConnections: number;
  /** Current keyspace size (key count). */
  keyspace: number;
  /** Current stored bytes (approximate; Upstash reports daily storage). */
  storageBytes: number;
  /** Last-known read latency mean (ms). */
  readLatencyMean: number;
  /** Last-known write latency mean (ms). */
  writeLatencyMean: number;
  /**
   * Real month-to-date charge in USD, straight from Upstash
   * (`total_monthly_billing`). This is the authoritative billed figure —
   * commands + storage already summed by Upstash — so the spend page
   * shows it as `invoiced` rather than re-deriving an estimate from the
   * command count. Resets at the start of each billing month.
   */
  monthlyBillingUsd: number;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Read the first non-zero value across plausible Upstash field names. */
function pick(stats: Record<string, unknown>, ...keys: string[]): number {
  for (const k of keys) {
    const v = num(stats[k]);
    if (v !== 0) return v;
  }
  return 0;
}

export async function getUpstashStats(dbId: string): Promise<Result<UpstashStats>> {
  return tryCatch(() =>
    cached(`upstash:stats:${dbId}`, 30, async () => {
      const stats = await req<Record<string, unknown>>(`/redis/stats/${dbId}`);
      return {
        monthlyRequests: pick(stats, 'total_monthly_requests', 'total_requests'),
        dailyRequests: pick(stats, 'daily_requests', 'requests_per_day'),
        monthlyBandwidthBytes: pick(stats, 'total_monthly_bandwidth', 'total_bandwidth'),
        dailyBandwidthBytes: pick(stats, 'daily_bandwidth', 'bandwidth_per_day'),
        monthlyConnections: pick(stats, 'total_monthly_connections', 'total_connections'),
        dailyConnections: pick(stats, 'daily_connections', 'connections_per_day'),
        keyspace: pick(stats, 'total_keys', 'keys'),
        storageBytes: pick(stats, 'daily_storage', 'storage_per_day', 'total_storage'),
        readLatencyMean: num(stats.read_latency_mean),
        writeLatencyMean: num(stats.write_latency_mean),
        monthlyBillingUsd: num(stats.total_monthly_billing),
      };
    })
  );
}

let cachedRedisUrl: string | null = null;
let cachedRestFor: { url: string; token: string; dbId: string } | null = null;

async function resolvePrimaryDb(): Promise<{
  dbId: string;
  endpoint: string;
  port: number;
  password: string;
  restToken: string;
}> {
  const list = await req<Array<Record<string, unknown>>>('/redis/databases');
  const primary = list[0];
  if (!primary) throw new Error('No Upstash databases');
  const dbId = primary.database_id as string;
  const detail = await req<Record<string, unknown>>(`/redis/database/${dbId}`);
  return {
    dbId,
    endpoint: (detail.endpoint as string) ?? '',
    port: (detail.port as number) ?? 6379,
    password: (detail.password as string) ?? '',
    restToken: (detail.rest_token as string) ?? '',
  };
}

export async function getRedisUrl(): Promise<string> {
  if (cachedRedisUrl) return cachedRedisUrl;
  const { endpoint, port, password } = await resolvePrimaryDb();
  cachedRedisUrl = `rediss://default:${encodeURIComponent(password)}@${endpoint}:${port}`;
  return cachedRedisUrl;
}

async function getRest(): Promise<{ url: string; token: string; dbId: string }> {
  if (cachedRestFor) return cachedRestFor;
  const { dbId, endpoint, restToken } = await resolvePrimaryDb();
  cachedRestFor = {
    url: `https://${endpoint}`,
    token: restToken,
    dbId,
  };
  return cachedRestFor;
}

export async function redisCmd(...cmd: Array<string | number>): Promise<unknown> {
  const rest = await getRest();
  const res = await fetch(rest.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${rest.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(cmd),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Upstash REST ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { result?: unknown; error?: string };
  if (json.error) throw new Error(`Upstash REST: ${json.error}`);
  return json.result;
}

export interface QueueDepth {
  queue: string;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

const QUEUE = 'scani-jobs';

export async function getQueueDepths(): Promise<Result<QueueDepth>> {
  return tryCatch(() =>
    cached('upstash:queue-depths', 10, async () => {
      // One pipelined round-trip instead of five parallel HTTPs.
      const [waiting, active, delayed, failed, completed] = await redisPipeline([
        ['LLEN', `bull:${QUEUE}:wait`],
        ['LLEN', `bull:${QUEUE}:active`],
        ['ZCARD', `bull:${QUEUE}:delayed`],
        ['ZCARD', `bull:${QUEUE}:failed`],
        ['ZCARD', `bull:${QUEUE}:completed`],
      ]);
      return {
        queue: QUEUE,
        waiting: Number(waiting) || 0,
        active: Number(active) || 0,
        delayed: Number(delayed) || 0,
        failed: Number(failed) || 0,
        completed: Number(completed) || 0,
      };
    })
  );
}
