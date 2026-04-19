/**
 * BullMQ queue inspection via Upstash REST.
 *
 * Read-only — all data fetching happens over the Upstash Redis REST API
 * using the `scani-jobs` queue's on-disk layout. Writes (retry, remove)
 * go through HMAC-gated endpoints on the backend so BullMQ's state
 * machine stays authoritative.
 */

import { type Result, tryCatch } from '../result';
import { redisCmd } from './upstash';

const QUEUE = 'scani-jobs';
const bkey = (suffix: string) => `bull:${QUEUE}:${suffix}`;

export type JobState = 'waiting' | 'active' | 'delayed' | 'failed' | 'completed';

export interface QueueOverview {
  queue: string;
  counts: Record<JobState, number>;
  byName: Array<{ name: string; count: number }>;
  recentFailures: JobSummary[];
}

export interface JobSummary {
  id: string;
  name: string;
  state: JobState | 'unknown';
  timestamp: number | null;
  processedOn: number | null;
  finishedOn: number | null;
  attemptsMade: number;
  failedReason: string | null;
}

export interface JobDetail extends JobSummary {
  data: Record<string, unknown> | null;
  returnvalue: unknown;
  opts: Record<string, unknown> | null;
  stacktrace: string[] | null;
  progress: number | null;
}

async function listIds(state: JobState, offset: number, limit: number): Promise<string[]> {
  const end = offset + limit - 1;
  if (state === 'waiting' || state === 'active') {
    const result = (await redisCmd(
      'LRANGE',
      bkey(state === 'waiting' ? 'wait' : 'active'),
      offset,
      end
    )) as string[] | null;
    return result ?? [];
  }
  // delayed, failed, completed are sorted sets, most-recent last.
  const result = (await redisCmd('ZRANGE', bkey(state), offset, end, 'REV')) as string[] | null;
  return result ?? [];
}

function normalizeHash(raw: unknown): Record<string, string> | null {
  if (!raw) return null;
  // Upstash may return either an object { field: value } or an array [field, value, ...]
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (let i = 0; i < raw.length; i += 2) {
      const k = String(raw[i]);
      const v = raw[i + 1] == null ? '' : String(raw[i + 1]);
      out[k] = v;
    }
    return out;
  }
  if (typeof raw === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = v == null ? '' : String(v);
    }
    return out;
  }
  return null;
}

function parseJobHash(id: string, hash: Record<string, string>): JobDetail {
  const parseJson = <T>(value: string | undefined, fallback: T): T => {
    if (value == null || value === '') return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  };

  const stacktrace = parseJson<string[]>(hash.stacktrace, []);
  const data = parseJson<Record<string, unknown> | null>(hash.data, null);
  const opts = parseJson<Record<string, unknown> | null>(hash.opts, null);
  const returnvalue = parseJson<unknown>(hash.returnvalue, null);

  const num = (v: string | undefined): number | null => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    id,
    name: hash.name ?? 'unknown',
    state: 'unknown',
    timestamp: num(hash.timestamp),
    processedOn: num(hash.processedOn),
    finishedOn: num(hash.finishedOn),
    attemptsMade: Number(hash.attemptsMade ?? 0) || 0,
    failedReason: hash.failedReason || null,
    data,
    returnvalue,
    opts,
    stacktrace: stacktrace.length ? stacktrace : null,
    progress: num(hash.progress),
  };
}

export async function getQueueOverview(): Promise<Result<QueueOverview>> {
  return tryCatch(async () => {
    const [waiting, active, delayed, failed, completed] = await Promise.all([
      redisCmd('LLEN', bkey('wait')),
      redisCmd('LLEN', bkey('active')),
      redisCmd('ZCARD', bkey('delayed')),
      redisCmd('ZCARD', bkey('failed')),
      redisCmd('ZCARD', bkey('completed')),
    ]);

    // Sample recent failures so the overview surfaces what's broken.
    const failedIds = await listIds('failed', 0, 10);
    const recentFailures: JobSummary[] = [];
    for (const id of failedIds) {
      const hash = normalizeHash(await redisCmd('HGETALL', bkey(id)));
      if (!hash) continue;
      const detail = parseJobHash(id, hash);
      recentFailures.push({
        id: detail.id,
        name: detail.name,
        state: 'failed',
        timestamp: detail.timestamp,
        processedOn: detail.processedOn,
        finishedOn: detail.finishedOn,
        attemptsMade: detail.attemptsMade,
        failedReason: detail.failedReason,
      });
    }

    // Group a small sample of recent jobs by name so the overview shows
    // which job families are most active. We pull at most 200 ids per
    // state — enough to spot trends, cheap on Upstash commands.
    const byNameMap = new Map<string, number>();
    const sampleLimit = 50;
    const allSampled: string[] = [];
    for (const state of ['waiting', 'active', 'failed', 'completed'] as const) {
      const ids = await listIds(state, 0, sampleLimit);
      allSampled.push(...ids);
    }
    for (const id of allSampled) {
      const hash = normalizeHash(await redisCmd('HGETALL', bkey(id)));
      const name = hash?.name ?? 'unknown';
      byNameMap.set(name, (byNameMap.get(name) ?? 0) + 1);
    }
    const byName = Array.from(byNameMap.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    return {
      queue: QUEUE,
      counts: {
        waiting: Number(waiting) || 0,
        active: Number(active) || 0,
        delayed: Number(delayed) || 0,
        failed: Number(failed) || 0,
        completed: Number(completed) || 0,
      },
      byName,
      recentFailures,
    };
  });
}

export async function listJobs(
  state: JobState,
  offset: number,
  limit: number
): Promise<Result<{ total: number; items: JobSummary[] }>> {
  return tryCatch(async () => {
    const totalRaw =
      state === 'waiting' || state === 'active'
        ? await redisCmd('LLEN', bkey(state === 'waiting' ? 'wait' : state))
        : await redisCmd('ZCARD', bkey(state));
    const total = Number(totalRaw) || 0;
    const ids = await listIds(state, offset, limit);
    const items: JobSummary[] = [];
    for (const id of ids) {
      const hash = normalizeHash(await redisCmd('HGETALL', bkey(id)));
      if (!hash) continue;
      const detail = parseJobHash(id, hash);
      items.push({
        id: detail.id,
        name: detail.name,
        state,
        timestamp: detail.timestamp,
        processedOn: detail.processedOn,
        finishedOn: detail.finishedOn,
        attemptsMade: detail.attemptsMade,
        failedReason: detail.failedReason,
      });
    }
    return { total, items };
  });
}

export async function getJobDetail(id: string): Promise<Result<JobDetail | null>> {
  return tryCatch(async () => {
    const hash = normalizeHash(await redisCmd('HGETALL', bkey(id)));
    if (!hash || Object.keys(hash).length === 0) return null;
    const detail = parseJobHash(id, hash);

    // Determine state by checking membership in each set/list. Cheap and
    // avoids stale state guesses based on timestamps alone.
    const checks: Array<[JobState, string]> = [
      ['active', 'active'],
      ['waiting', 'wait'],
      ['delayed', 'delayed'],
      ['failed', 'failed'],
      ['completed', 'completed'],
    ];
    for (const [state, suffix] of checks) {
      const cmd =
        state === 'active' || state === 'waiting'
          ? await redisCmd('LPOS', bkey(suffix), id)
          : await redisCmd('ZSCORE', bkey(suffix), id);
      if (cmd != null) {
        detail.state = state;
        break;
      }
    }

    // Redact credential-looking fields from the payload preview.
    if (detail.data) {
      detail.data = redactSensitive(detail.data);
    }
    return detail;
  });
}

function redactSensitive(data: Record<string, unknown>): Record<string, unknown> {
  const SENSITIVE = new Set([
    'apikey',
    'apisecret',
    'apitoken',
    'password',
    'passphrase',
    'credentials',
    'credentialsencrypted',
    'secret',
    'token',
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SENSITIVE.has(k.toLowerCase())) {
      out[k] = '[redacted]';
    } else {
      out[k] = v;
    }
  }
  return out;
}
