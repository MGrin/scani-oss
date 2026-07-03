/**
 * BullMQ queue inspection via the backend's HMAC-gated redis-read proxy.
 *
 * Read-only — the queue Redis lives inside the scani-worker Fly machine
 * (6PN private network only; the metered Upstash database it replaced
 * billed ~$40/mo for idle BullMQ polling), so this app can't reach it
 * directly. All data fetching POSTs a pipeline of whitelisted read-only
 * commands to `/admin/jobs/redis-read` on the backend, signed with the
 * same HMAC scheme as the write endpoints. Writes (retry, remove) keep
 * their dedicated endpoints so BullMQ's state machine stays
 * authoritative.
 *
 * Everything here uses `redisPipeline()` where possible: the admin
 * dashboard is not on the hot path but it used to issue ~215 sequential
 * calls per page load (sample 50 × 4 states × HGETALL), which made the
 * UI feel irresponsive. Batch-and-cache brings it to 2 round-trips.
 */

import { cached } from '../cache';
import { type Result, tryCatch } from '../result';
import { redisPipeline } from './queue-redis';

const QUEUE = 'scani-jobs';
const DLQ = 'scani-dlq';
const bkey = (suffix: string) => `bull:${QUEUE}:${suffix}`;
const dlqKey = (suffix: string) => `bull:${DLQ}:${suffix}`;

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

/** Build the Redis command to range-scan a state's id list/set. */
function rangeCmd(state: JobState, offset: number, limit: number): Array<string | number> {
  const end = offset + limit - 1;
  if (state === 'waiting' || state === 'active') {
    return ['LRANGE', bkey(state === 'waiting' ? 'wait' : 'active'), offset, end];
  }
  return ['ZRANGE', bkey(state), offset, end, 'REV'];
}

/** Build the Redis command for counting a state's entries. */
function countCmd(state: JobState): Array<string | number> {
  if (state === 'waiting' || state === 'active') {
    return ['LLEN', bkey(state === 'waiting' ? 'wait' : state)];
  }
  return ['ZCARD', bkey(state)];
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
  return tryCatch(() =>
    cached('bullmq:overview', 10, async () => {
      // Round-trip 1: counts for all states + recent-failures range +
      // per-state sample ranges, all in one pipeline.
      const SAMPLE_LIMIT = 50;
      const FAIL_SAMPLE = 10;
      const countCmds = [
        countCmd('waiting'),
        countCmd('active'),
        countCmd('delayed'),
        countCmd('failed'),
        countCmd('completed'),
      ];
      const rangeCmds = [
        rangeCmd('failed', 0, FAIL_SAMPLE),
        rangeCmd('waiting', 0, SAMPLE_LIMIT),
        rangeCmd('active', 0, SAMPLE_LIMIT),
        rangeCmd('failed', 0, SAMPLE_LIMIT),
        rangeCmd('completed', 0, SAMPLE_LIMIT),
      ];
      const firstBatch = await redisPipeline([...countCmds, ...rangeCmds]);
      const [waiting, active, delayed, failed, completed] = firstBatch.slice(0, 5);
      const [failedIdsForDetail, waitingIds, activeIds, failedIdsSample, completedIds] = firstBatch
        .slice(5)
        .map((r) => (Array.isArray(r) ? (r as string[]) : [])) as string[][];

      // Dedup across samples so we never HGETALL the same id twice.
      const sampledIds = Array.from(
        new Set([
          ...failedIdsForDetail,
          ...waitingIds,
          ...activeIds,
          ...failedIdsSample,
          ...completedIds,
        ])
      );

      // Round-trip 2: fetch every sampled job's hash in one pipeline.
      const hashes = sampledIds.length
        ? await redisPipeline(sampledIds.map((id) => ['HGETALL', bkey(id)]))
        : [];
      const hashById = new Map<string, Record<string, string> | null>();
      sampledIds.forEach((id, i) => {
        hashById.set(id, normalizeHash(hashes[i]));
      });

      const recentFailures: JobSummary[] = [];
      for (const id of failedIdsForDetail) {
        const hash = hashById.get(id);
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

      // "Jobs by name" sampled across all four states — shows which
      // families are most active without scanning the entire history.
      const byNameMap = new Map<string, number>();
      for (const id of [...waitingIds, ...activeIds, ...failedIdsSample, ...completedIds]) {
        const name = hashById.get(id)?.name ?? 'unknown';
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
    })
  );
}

export async function listJobs(
  state: JobState,
  offset: number,
  limit: number
): Promise<Result<{ total: number; items: JobSummary[] }>> {
  return tryCatch(() =>
    cached(`bullmq:list:${state}:${offset}:${limit}`, 5, async () => {
      // Round-trip 1: total + id range in one batch.
      const [totalRaw, idsRaw] = await redisPipeline([
        countCmd(state),
        rangeCmd(state, offset, limit),
      ]);
      const total = Number(totalRaw) || 0;
      const ids = Array.isArray(idsRaw) ? (idsRaw as string[]) : [];
      if (ids.length === 0) return { total, items: [] };

      // Round-trip 2: fetch all job hashes in one pipelined batch.
      const hashes = await redisPipeline(ids.map((id) => ['HGETALL', bkey(id)]));
      const items: JobSummary[] = [];
      ids.forEach((id, i) => {
        const hash = normalizeHash(hashes[i]);
        if (!hash) return;
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
      });
      return { total, items };
    })
  );
}

export async function getJobDetail(id: string): Promise<Result<JobDetail | null>> {
  return tryCatch(() =>
    cached(`bullmq:job:${id}`, 5, async () => {
      // One pipelined round-trip for HGETALL + all five membership checks.
      const checks: Array<[JobState, string, 'list' | 'zset']> = [
        ['active', 'active', 'list'],
        ['waiting', 'wait', 'list'],
        ['delayed', 'delayed', 'zset'],
        ['failed', 'failed', 'zset'],
        ['completed', 'completed', 'zset'],
      ];
      const batch = await redisPipeline([
        ['HGETALL', bkey(id)],
        ...checks.map(([, suffix, kind]) =>
          kind === 'list' ? ['LPOS', bkey(suffix), id] : ['ZSCORE', bkey(suffix), id]
        ),
      ]);
      const hash = normalizeHash(batch[0]);
      if (!hash || Object.keys(hash).length === 0) return null;
      const detail = parseJobHash(id, hash);

      const membershipResults = batch.slice(1);
      for (let i = 0; i < checks.length; i++) {
        if (membershipResults[i] != null) {
          detail.state = checks[i][0];
          break;
        }
      }

      if (detail.data) {
        detail.data = redactSensitive(detail.data);
      }
      return detail;
    })
  );
}

export interface DlqOverview {
  queue: string;
  /** Total entries in the DLQ failed-zset. */
  depth: number;
  /** Most recent N failed jobs (newest first). */
  recent: JobSummary[];
}

/**
 * Read DLQ depth + a sample of recent entries. The DLQ is its own BullMQ
 * queue (`scani-dlq`); jobs land there after exhausting their retry
 * attempts on the main queue. Replay action lives behind an HMAC proxy
 * (Phase 4) — this client is read-only.
 */
export async function getDlqOverview(): Promise<Result<DlqOverview>> {
  return tryCatch(() =>
    cached('bullmq:dlq', 10, async () => {
      const SAMPLE = 25;
      // BullMQ records DLQ entries in the same failed-zset shape as a
      // normal queue, so we can reuse ZCARD + ZRANGE-REV + HGETALL.
      const [depthRaw, idsRaw] = await redisPipeline([
        ['ZCARD', dlqKey('failed')],
        ['ZRANGE', dlqKey('failed'), 0, SAMPLE - 1, 'REV'],
      ]);
      const depth = Number(depthRaw) || 0;
      const ids = Array.isArray(idsRaw) ? (idsRaw as string[]) : [];

      const hashes = ids.length
        ? await redisPipeline(ids.map((id) => ['HGETALL', dlqKey(id)]))
        : [];

      const recent: JobSummary[] = [];
      ids.forEach((id, i) => {
        const hash = normalizeHash(hashes[i]);
        if (!hash) return;
        const detail = parseJobHash(id, hash);
        recent.push({
          id: detail.id,
          name: detail.name,
          state: 'failed',
          timestamp: detail.timestamp,
          processedOn: detail.processedOn,
          finishedOn: detail.finishedOn,
          attemptsMade: detail.attemptsMade,
          failedReason: detail.failedReason,
        });
      });

      return { queue: DLQ, depth, recent };
    })
  );
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
