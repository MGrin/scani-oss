import { describe, expect, test } from 'bun:test';
import {
  postgresJsSsl,
  verifiedLibpqConnectionString,
  verifiedPgConnectionString,
} from '../src/postgres-tls';

/** The shape Neon's API emits for both the direct and the pooled endpoint. */
const NEON = 'postgresql://u:p@ep-x.aws.neon.tech/neondb?channel_binding=require&sslmode=require';

describe('SC-784 — every hosted Postgres connection verifies the server', () => {
  test("postgres.js never gets 'require', which verifies nothing", () => {
    for (const mode of ['require', 'prefer', 'allow', 'no-verify', 'verify-ca', 'verify-full']) {
      expect(postgresJsSsl(`postgres://u:p@db.example/x?sslmode=${mode}`)).toBe('verify-full');
    }
    expect(postgresJsSsl(NEON)).toBe('verify-full');
    expect(postgresJsSsl('postgres://u:p@db.example/x')).toBe('verify-full');
  });

  test('pg gets verify-full, and no sslrootcert it would read as a file', () => {
    const url = new URL(verifiedPgConnectionString(NEON));
    expect(url.searchParams.get('sslmode')).toBe('verify-full');
    expect(url.searchParams.get('sslrootcert')).toBeNull();
    // Control: the rewrite keeps what it does not own.
    expect(url.searchParams.get('channel_binding')).toBe('require');
    expect(url.hostname).toBe('ep-x.aws.neon.tech');
  });

  test('libpq gets verify-full against the system root store', () => {
    const url = new URL(verifiedLibpqConnectionString(NEON, {}));
    expect(url.searchParams.get('sslmode')).toBe('verify-full');
    expect(url.searchParams.get('sslrootcert')).toBe('system');
  });

  test('a private CA named by PGSSLROOTCERT is not overridden by the URL', () => {
    const url = new URL(verifiedLibpqConnectionString(NEON, { PGSSLROOTCERT: '/certs/rds.pem' }));
    expect(url.searchParams.get('sslmode')).toBe('verify-full');
    // libpq reads the env var only when the URL names no sslrootcert.
    expect(url.searchParams.get('sslrootcert')).toBeNull();
    expect(
      new URL(
        verifiedLibpqConnectionString(`${NEON}&sslrootcert=/certs/rds.pem`, {})
      ).searchParams.getAll('sslrootcert')
    ).toEqual(['/certs/rds.pem']);
  });

  test('the only exits: an explicit disable, or loopback with no sslmode', () => {
    const disabled = 'postgres://scani:scani@postgres:5432/scani?sslmode=disable';
    expect(postgresJsSsl(disabled)).toBe(false);
    expect(verifiedPgConnectionString(disabled)).toBe(disabled);
    expect(verifiedLibpqConnectionString(disabled)).toBe(disabled);

    expect(postgresJsSsl('postgres://u:p@localhost:5433/x')).toBe(false);
    expect(postgresJsSsl('postgres://u:p@127.0.0.1:5433/x')).toBe(false);
    // Loopback does not excuse an explicit request for TLS.
    expect(postgresJsSsl('postgres://u:p@localhost:5433/x?sslmode=require')).toBe('verify-full');
  });

  test('an unparseable URL fails closed', () => {
    expect(postgresJsSsl('not a url')).toBe('verify-full');
    expect(verifiedPgConnectionString('not a url')).toBe('not a url');
  });
});
