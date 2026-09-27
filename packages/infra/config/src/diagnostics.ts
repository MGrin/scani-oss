import { timingSafeEqual } from 'node:crypto';

/**
 * SC-1357. The detailed health routes are public and exempt from the edge
 * lock, so their bodies reach anyone: raw driver errors, pool config, which
 * provider keys are missing. A caller with the configured `DIAGNOSTICS_TOKEN`
 * gets the full body; everyone else gets `publicHealthBody`, which keeps every
 * field a deploy smoke, a Fly check or the demo verdict reads.
 *
 * No token configured means nobody is authorized. An empty bearer must never
 * match an empty setting.
 */
export function diagnosticsAuthorized(request: Request, token: string | undefined): boolean {
  if (!token) return false;
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/**
 * `nameResolutionFailure` stays because `recycle-redis-consumers.sh` acts on
 * it after a deploy, and a boolean names nothing about the host.
 */
const PUBLIC_CHECK_FLAGS = ['nameResolutionFailure'] as const;

type HealthCheck = { ok?: unknown } & Record<string, unknown>;

export function publicHealthBody(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ('status' in body) out.status = body.status;
  // `/health/r2` reports on its top level, and the api's deep check reads it.
  if (typeof body.ok === 'boolean') out.ok = body.ok;
  if ('timestamp' in body) out.timestamp = body.timestamp;
  const checks = body.checks;
  if (checks && typeof checks === 'object') {
    const reduced: Record<string, Record<string, boolean>> = {};
    for (const [name, check] of Object.entries(checks as Record<string, HealthCheck>)) {
      const kept: Record<string, boolean> = { ok: check?.ok === true };
      for (const flag of PUBLIC_CHECK_FLAGS) {
        if (typeof check?.[flag] === 'boolean') kept[flag] = check[flag] as boolean;
      }
      reduced[name] = kept;
    }
    out.checks = reduced;
  }
  return out;
}

/** The full body for an authorized caller, the reduced one for everyone else. */
export function healthBodyFor(
  request: Request,
  token: string | undefined,
  body: Record<string, unknown>
): Record<string, unknown> {
  return diagnosticsAuthorized(request, token) ? body : publicHealthBody(body);
}
