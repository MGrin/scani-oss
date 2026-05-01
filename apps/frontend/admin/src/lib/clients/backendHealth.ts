import { cached } from '../cache';
import { type Result, tryCatch } from '../result';

const HEALTH_URL = 'https://api.scani.xyz/health';
const DB_HEALTH_URL = 'https://api.scani.xyz/health/db';

export interface BackendHealth {
  ok: boolean;
  payload: unknown;
  statusCode: number;
}

async function probe(url: string): Promise<BackendHealth> {
  const res = await fetch(url, { cache: 'no-store' });
  const text = await res.text();
  let payload: unknown = text;
  try {
    payload = JSON.parse(text);
  } catch {
    // Body isn't JSON — keep the raw text so the admin card can still
    // surface something useful.
  }
  return { ok: res.ok, payload, statusCode: res.status };
}

export async function getBackendHealth(): Promise<Result<BackendHealth>> {
  return tryCatch(() => cached('backend:health', 15, () => probe(HEALTH_URL)));
}

export async function getBackendDbHealth(): Promise<Result<BackendHealth>> {
  return tryCatch(() => cached('backend:health-db', 15, () => probe(DB_HEALTH_URL)));
}
