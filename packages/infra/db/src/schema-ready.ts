import { client } from './connection';

// Workers boot before CI's migrate job has applied the latest migration if
// the deploy got reordered, or before Neon's autoscaling-from-zero compute
// has taken the last apply. Either way, scheduled jobs that fire every
// minute will crash with `relation "<table>" does not exist` and pile up
// in the DLQ until something restarts. Block boot until the canary tables
// are visible.
const REQUIRED_TABLES = ['user_jobs', 'tokens', 'holdings'] as const;

export interface SchemaReadyOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export async function awaitSchemaReady(opts: SchemaReadyOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const pollMs = opts.pollMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const missing: string[] = [];
    for (const table of REQUIRED_TABLES) {
      const qualified = `public.${table}`;
      const rows = await client<{ exists: boolean }[]>`
        SELECT to_regclass(${qualified}) IS NOT NULL AS exists
      `;
      if (!rows[0]?.exists) missing.push(table);
    }
    if (missing.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(
        `Schema not ready after ${timeoutMs}ms — missing tables: ${missing.join(', ')}`
      );
    }
    await Bun.sleep(pollMs);
  }
}
