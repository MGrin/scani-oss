import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { STACK_SERVICES } from '../lib/worktree';

/**
 * SC-1299. Compose publishes on ALL interfaces when a port mapping names no
 * bind address, and `docker-compose.yml` named none for any of its ports.
 * Measured 2026-09-23 with the stack up, from the machine's own LAN address:
 * `psql -h <lan-ip> -p <the postgres port> -U scani` opened a session with the
 * dev credentials that are written in this repository. The laptop it was
 * measured on has the macOS application firewall off and travels, so "the
 * network" is whatever cafe or airport Wi-Fi it last joined — but nothing
 * about the defect needs that: a default of all-interfaces is a default of
 * whatever network the machine is on.
 *
 * A HALF-DONE BIND READS AS FIXED. That is why this is a test and not a review
 * note: eight of nine prefixed is indistinguishable, from the file, from nine,
 * and the ninth is still an open door. So it asserts over EVERY `ports:` entry
 * the file contains rather than over a list written down here.
 *
 * Read as TEXT, like `compose-urls-follow-ports.test.ts` beside it and for the
 * same reason: `docker compose config` resolves the interpolation and hands
 * back a literal port, which is the very thing the third test forbids. Both
 * properties matter and only the unresolved source carries both — a mapping
 * written `127.0.0.1:5433:5432` is loopback-bound and un-overridable, which is
 * the defect SC-500 is about.
 *
 * NOT `localhost:`. Docker resolves the bind address at publish time and
 * `localhost` is ambiguous between 127.0.0.1 and ::1; the literal is what
 * `docker ps` echoes back, so the file and the falsifier agree.
 *
 * THE CENSUS ARM IS WRITTEN TO HOLD IN BOTH REPOSITORIES. `STACK_SERVICES` is
 * byte-identical in the private tree and the mirror, and the two
 * `docker-compose.yml` files are not — that file is `merge=ours`-pinned, and
 * the private one additionally publishes landing, cloud and admin. Quantifying
 * over `STACK_SERVICES` would therefore be a rule that is green in one tree
 * and red in the other for reasons having nothing to do with binding. The
 * floor below is the seven services both files run, which is what makes an
 * empty parse fail loudly instead of passing by iterating zero times.
 */
const COMPOSE = new URL('../../docker-compose.yml', import.meta.url);
const SOURCE = readFileSync(COMPOSE, 'utf8');

/** The services both repositories' compose files run. */
const REQUIRED = [
  'POSTGRES_HOST_PORT',
  'REDIS_HOST_PORT',
  'MAILPIT_SMTP_HOST_PORT',
  'MAILPIT_UI_HOST_PORT',
  'MINIO_API_HOST_PORT',
  'MINIO_CONSOLE_HOST_PORT',
  'DATA_PROVIDER_HOST_PORT',
  'API_HOST_PORT',
  'FRONTEND_HOST_PORT',
] as const;

interface Publication {
  line: number;
  text: string;
  /** The mapping inside the quotes, e.g. `127.0.0.1:${POSTGRES_HOST_PORT:-5433}:5432`. */
  mapping: string;
}

/**
 * Every host-port publication in the file.
 *
 * A `ports:` list item is the only thing that publishes; `expose:` does not,
 * and neither does a port written in prose. Comment lines are dropped for the
 * same reason the sibling test drops them — the header documents the defaults
 * and is not a mapping.
 */
function publications(): Publication[] {
  const lines = SOURCE.split('\n');
  const found: Publication[] = [];
  let inPorts = false;
  let indent = 0;
  for (const [index, text] of lines.entries()) {
    if (/^\s*#/.test(text) || text.trim() === '') continue;
    const item = text.match(/^(\s*)- (.*)$/);
    if (inPorts && item && item[1]!.length > indent) {
      const mapping = item[2]!
        .replace(/\s+#.*$/, '')
        .trim()
        .replace(/^["']|["']$/g, '');
      found.push({ line: index + 1, text: text.trim(), mapping });
      continue;
    }
    const ports = text.match(/^(\s*)ports:\s*$/);
    if (ports) {
      inPorts = true;
      indent = ports[1]!.length;
      continue;
    }
    inPorts = false;
  }
  return found;
}

describe('every published port binds loopback (SC-1299)', () => {
  const found = publications();
  const variables = new Set(
    found.flatMap((p) => [...p.mapping.matchAll(/\$\{([A-Z0-9_]+):-\d+\}/g)].map((m) => m[1]!))
  );

  test('the file still publishes the services both repositories run', () => {
    // Without this, a file publishing nothing at all — or one whose `ports:`
    // blocks this parser stopped recognising — would pass everything below by
    // iterating zero times.
    for (const name of REQUIRED) {
      expect(variables.has(name), `${name} publishes no port`).toBe(true);
    }
  });

  test('every published port is one the port derivation knows', () => {
    // A typo'd variable is un-overridable in the same way a literal is: nothing
    // in `resolveStackPorts` reads it, so it silently keeps its default.
    const known = new Set(STACK_SERVICES.map((s) => s.env));
    expect([...variables].filter((name) => !known.has(name))).toEqual([]);
  });

  test('none publishes on all interfaces', () => {
    expect(found.length).toBeGreaterThan(0);
    const exposed = found
      .filter((p) => !p.mapping.startsWith('127.0.0.1:'))
      .map((p) => `docker-compose.yml:${p.line}  ${p.text}`);
    expect(exposed).toEqual([]);
  });

  test('the loopback prefix did not eat the host-port override', () => {
    expect(found.length).toBeGreaterThan(0);
    const fixed = found
      .filter((p) => !/^127\.0\.0\.1:\$\{[A-Z0-9_]+:-\d+\}:\d+$/.test(p.mapping))
      .map((p) => `docker-compose.yml:${p.line}  ${p.text}`);
    expect(fixed).toEqual([]);
  });
});
