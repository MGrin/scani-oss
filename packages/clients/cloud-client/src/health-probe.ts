import { loadCloudClientConfig } from './config';

// Boot-time data-provider reachability check. A misconfigured SCANI_CLOUD_URL
// (typo, network split, dead VM) would otherwise let the process boot
// healthy and only fail at the first user request. Failing fast at boot
// turns it into a one-line crash.
//
// In dev (SCANI_CLOUD_URL unset) this is a no-op.

export interface ProbeOptions {
  timeoutMs?: number;
  /** Max number of attempts (default 3). Each backs off with linear jitter. */
  attempts?: number;
}

export interface ProbeResult {
  ok: boolean;
  url?: string;
  status?: number;
  error?: string;
  attempts: number;
}

export async function probeDataProvider(opts: ProbeOptions = {}): Promise<ProbeResult> {
  const { SCANI_CLOUD_URL: url } = loadCloudClientConfig();
  if (!url) return { ok: true, attempts: 0 };

  const baseUrl = url.replace(/\/$/, '');
  const timeoutMs = opts.timeoutMs ?? 3000;
  const maxAttempts = opts.attempts ?? 3;

  let lastError: string | undefined;
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/health`, {
        signal: ctrl.signal,
        headers: { accept: 'application/json' },
      });
      lastStatus = res.status;
      if (res.ok) return { ok: true, url, status: res.status, attempts: attempt };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < maxAttempts) {
      const delay = attempt * 200 + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return { ok: false, url, status: lastStatus, error: lastError, attempts: maxAttempts };
}
