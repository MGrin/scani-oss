/**
 * Boot-time data-provider reachability check.
 *
 * Backend + worker call this before they start serving traffic / consuming
 * jobs. A misconfigured `SCANI_CLOUD_URL` (typo, network split, dead VM)
 * otherwise lets the process boot healthy and only fails at the first user
 * request — debugging that in prod requires correlating logs across two
 * services. Failing fast at boot turns it into a one-line crash.
 *
 * In dev (`SCANI_CLOUD_URL` unset) this is a no-op so contributors can run
 * the backend without a data-provider sidecar.
 */

export interface ProbeOptions {
  url: string | undefined;
  timeoutMs?: number;
  /** Max number of attempts (default 3). Each backs off with linear jitter. */
  attempts?: number;
}

export interface ProbeResult {
  ok: boolean;
  status?: number;
  error?: string;
  attempts: number;
}

export async function probeDataProvider(opts: ProbeOptions): Promise<ProbeResult> {
  if (!opts.url) return { ok: true, attempts: 0 };

  const baseUrl = opts.url.replace(/\/$/, '');
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
      if (res.ok) return { ok: true, status: res.status, attempts: attempt };
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < maxAttempts) {
      // Linear backoff with jitter: 200, 400, 600 ms ± 100ms.
      const delay = attempt * 200 + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  return { ok: false, status: lastStatus, error: lastError, attempts: maxAttempts };
}
