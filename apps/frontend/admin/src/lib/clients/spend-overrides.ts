/**
 * Operator-entered actual bills, persisted in Upstash.
 *
 * No vendor API exposes the authoritative monthly invoice total for Neon
 * or Fly (only Cloudflare and Upstash report real charges), and the live
 * usage APIs only ever return *current* month-to-date — so last month's
 * bill can't be reconstructed from them. The operator records the real
 * figure off each invoice; it supersedes the estimate for that
 * provider+period on the spend page.
 *
 * Stored as a single Redis hash so each (period, provider) edit is an
 * atomic `HSET`/`HDEL` — no read-modify-write race on the JSON blob.
 * Field key is `<period>:<provider>` (e.g. `2026-05:neon`); value is the
 * JSON `SpendOverride`. No TTL — these are durable records.
 */

import { type Result, tryCatch } from '../result';
import type { SpendOverride, SpendProvider } from './spend-pricing';
import { redisCmd } from './upstash';

const KEY = 'admin:spend:overrides';

function fieldFor(period: string, provider: SpendProvider): string {
  return `${period}:${provider}`;
}

/**
 * Upstash REST returns `HGETALL` either as a flat `[field, value, …]`
 * array or (depending on encoding) an object. Normalize both to values.
 */
function hgetallValues(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    const values: string[] = [];
    for (let i = 1; i < raw.length; i += 2) {
      if (typeof raw[i] === 'string') values.push(raw[i] as string);
    }
    return values;
  }
  if (raw && typeof raw === 'object') {
    return Object.values(raw as Record<string, unknown>).filter(
      (v): v is string => typeof v === 'string'
    );
  }
  return [];
}

export async function getSpendOverrides(): Promise<Result<SpendOverride[]>> {
  return tryCatch(async () => {
    const raw = await redisCmd('HGETALL', KEY);
    const out: SpendOverride[] = [];
    for (const value of hgetallValues(raw)) {
      try {
        const parsed = JSON.parse(value) as SpendOverride;
        if (parsed && typeof parsed.provider === 'string' && typeof parsed.period === 'string') {
          out.push(parsed);
        }
      } catch {
        // Skip a malformed row rather than failing the whole page.
      }
    }
    return out;
  });
}

export async function upsertSpendOverride(o: SpendOverride): Promise<void> {
  await redisCmd('HSET', KEY, fieldFor(o.period, o.provider), JSON.stringify(o));
}

export async function removeSpendOverride(
  provider: SpendProvider,
  period: string
): Promise<number> {
  const removed = await redisCmd('HDEL', KEY, fieldFor(period, provider));
  return Number(removed) || 0;
}
