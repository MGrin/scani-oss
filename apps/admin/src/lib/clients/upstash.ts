import { cached } from '../cache';
import { getEnv } from '../env';
import { type Result, tryCatch } from '../result';

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
  dailyBandwidth: number;
  dbSizeBytes: number;
  totalCommands: number;
  totalConnections: number;
  totalDailyBandwidth: number;
  readLatencyMean: number;
  writeLatencyMean: number;
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
        dailyBandwidth: (d.daily_bandwidth as number) ?? 0,
        dbSizeBytes: (d.db_disk_threshold as number) ?? (d.db_max_size as number) ?? 0,
        totalCommands: (d.db_total_commands as number) ?? 0,
        totalConnections: (d.db_total_connections as number) ?? 0,
        totalDailyBandwidth: (d.db_daily_bandwidth as number) ?? 0,
        readLatencyMean: (d.db_read_latency_mean as number) ?? 0,
        writeLatencyMean: (d.db_write_latency_mean as number) ?? 0,
        createdAt: (d.creation_time as number) ?? 0,
      }));
    })
  );
}

export interface UpstashStats {
  dailyCommands: number;
  readLatencyMean: number;
  writeLatencyMean: number;
  bandwidth: number;
  totalConnections: number;
  keyspace: number;
}

export async function getUpstashStats(dbId: string): Promise<Result<UpstashStats>> {
  return tryCatch(() =>
    cached(`upstash:stats:${dbId}`, 30, async () => {
      const stats = await req<Record<string, unknown>>(`/redis/stats/${dbId}`);
      return {
        dailyCommands:
          Number((stats.total_monthly_requests as number) ?? 0) ||
          Number((stats.total_commands as number) ?? 0),
        readLatencyMean: Number(stats.read_latency_mean ?? 0),
        writeLatencyMean: Number(stats.write_latency_mean ?? 0),
        bandwidth: Number(stats.daily_bandwidth ?? 0),
        totalConnections: Number(stats.total_connections ?? 0),
        keyspace: Number(stats.total_keys ?? 0),
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

/**
 * Batch N Redis commands in a single HTTP round-trip. Upstash returns
 * one response object per command in input order. Per-command errors
 * don't abort the batch — each result carries its own `error`/`result`
 * field, which we translate into the same `unknown | throw` shape as
 * `redisCmd` per-element.
 *
 * Used for the BullMQ dashboard, where the hand-rolled loop was
 * issuing 200+ sequential HTTP calls on every page load.
 */
export async function redisPipeline(commands: Array<Array<string | number>>): Promise<unknown[]> {
  if (commands.length === 0) return [];
  const rest = await getRest();
  const res = await fetch(`${rest.url}/pipeline`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${rest.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(commands),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Upstash REST pipeline ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  return json.map((entry, i) => {
    if (entry.error) {
      throw new Error(`Upstash pipeline cmd ${i} (${commands[i]?.[0]}): ${entry.error}`);
    }
    return entry.result;
  });
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
