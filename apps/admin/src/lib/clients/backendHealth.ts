import { type Result, tryCatch } from '../result';

const HEALTH_URL = 'https://api.scani.xyz/health';
const DB_HEALTH_URL = 'https://api.scani.xyz/health/db';

export interface BackendHealth {
  ok: boolean;
  payload: unknown;
  statusCode: number;
}

export async function getBackendHealth(): Promise<Result<BackendHealth>> {
  return tryCatch(async () => {
    const res = await fetch(HEALTH_URL, { cache: 'no-store' });
    const text = await res.text();
    let payload: unknown = text;
    try {
      payload = JSON.parse(text);
    } catch {
      // text already
    }
    return { ok: res.ok, payload, statusCode: res.status };
  });
}

export async function getBackendDbHealth(): Promise<Result<BackendHealth>> {
  return tryCatch(async () => {
    const res = await fetch(DB_HEALTH_URL, { cache: 'no-store' });
    const text = await res.text();
    let payload: unknown = text;
    try {
      payload = JSON.parse(text);
    } catch {
      // already
    }
    return { ok: res.ok, payload, statusCode: res.status };
  });
}
