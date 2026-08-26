import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SC-492: `apps/backend/api/Dockerfile` probed `http://localhost:3001/readyz`
 * with the port written in. That is correct for `docker-compose.prod.yml` and
 * for the OSS `docker-compose.yml` — both set `PORT: 3001` — and wrong for the
 * private `docker-compose.yml`, which has run the api on 8080 since the Fly
 * migration. The container reported `unhealthy` for months in the one stack we
 * develop against, while its own log read `port=8080`.
 *
 * ## Why a hardcoded probe port is the thing to ban, not the specific 3001
 *
 * It was not wrong when written. It became wrong when a compose moved the
 * port, and nothing announced that — `docker ps` said `unhealthy`, which is
 * also what a genuinely broken api says, so the one signal that would report a
 * real failure was already red and unreadable.
 *
 * Nor could the environment we watch most closely catch it: Fly never executes
 * a Dockerfile HEALTHCHECK, it runs its own `[checks]` against `internal_port`.
 *
 * So the rule is about the SHAPE — a probe must read the port from the
 * environment the server reads it from — rather than about any value, because
 * a value-agreement test would have passed on the day this was introduced.
 */

const BACKEND = new URL('../../apps/backend', import.meta.url).pathname;

interface Probe {
  readonly app: string;
  readonly line: string;
}

function healthcheckProbes(): Probe[] {
  const out: Probe[] = [];
  for (const app of readdirSync(BACKEND)) {
    let text: string;
    try {
      text = readFileSync(join(BACKEND, app, 'Dockerfile'), 'utf8');
    } catch {
      continue;
    }
    // Join continuations so the CMD lands on one logical line.
    const joined = text.replace(/\\\n\s*/g, ' ');
    for (const line of joined.split('\n')) {
      if (/^HEALTHCHECK\b/.test(line)) out.push({ app, line });
    }
  }
  return out;
}

describe('a Dockerfile healthcheck reads the port from the environment (SC-492)', () => {
  const probes = healthcheckProbes();

  test('baseline: the probes are found at all', () => {
    // Without this, every assertion below passes over an empty list — the
    // shape of failure this repo keeps paying for.
    expect(probes.length).toBeGreaterThanOrEqual(2);
    expect(probes.map((p) => p.app).sort()).toContain('api');
    expect(probes.map((p) => p.app).sort()).toContain('data-provider');
  });

  test.each(
    probes.map((p) => [p.app, p.line] as const)
  )('%s probes a port taken from the environment', (_app, line) => {
    // Only localhost probes are in scope: a healthcheck that talks to
    // something else is not making a claim about this server's port.
    if (!/localhost/.test(line)) return;
    expect(line).toContain('${PORT');
  });

  test.each(
    probes.map((p) => [p.app, p.line] as const)
  )('%s does not write a literal port into a localhost probe', (_app, line) => {
    if (!/localhost/.test(line)) return;
    // `localhost:1234` with digits straight after the colon is the banned
    // shape. `localhost:${PORT:-1234}` is fine — the default lives inside
    // the expansion, where an environment can still override it.
    expect(line).not.toMatch(/localhost:\d/);
  });
});
