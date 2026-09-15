/**
 * How every Postgres connection in this repo verifies the server (SC-784).
 *
 * `sslmode=require` is what Neon emits and what the docs prescribe, and it
 * does NOT mean the same thing in our three clients. Measured against a server
 * whose certificate came from an untrusted CA, and again with a certificate for
 * another host name:
 *
 *   postgres.js `ssl: 'require'`          connected — encrypts, verifies nothing
 *   libpq (`pg_dump`) `sslmode=require`   connected — same
 *   pg 8 `sslmode=require`                refused — an alias for verify-full today,
 *                                         and plain libpq `require` from pg 9
 *
 * So the app connection and the nightly dump never verified, and the one client
 * that did was one major bump from stopping. Every hosted connection is therefore
 * upgraded to verify-full here, whatever the URL says. The only exits are an
 * explicit `sslmode=disable` (the compose Postgres, which has no TLS) and a
 * loopback host with no sslmode at all. An unparseable URL gets verify-full from
 * `postgresJsSsl` and is passed through untouched by the string rewriters, where
 * the driver's own parse fails loudly — nothing unparseable connects unverified.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

type Tls = 'verify-full' | 'off';

function tlsFor(databaseUrl: string): { url: URL | null; tls: Tls } {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return { url: null, tls: 'verify-full' };
  }
  const mode = url.searchParams.get('sslmode');
  if (mode === 'disable') return { url, tls: 'off' };
  if (mode === null && LOOPBACK.has(url.hostname)) return { url, tls: 'off' };
  return { url, tls: 'verify-full' };
}

/** The `ssl` option for `postgres(...)`. Never `'require'`. */
export function postgresJsSsl(databaseUrl: string): false | 'verify-full' {
  return tlsFor(databaseUrl).tls === 'off' ? false : 'verify-full';
}

/**
 * A connection string for node-postgres (`pg`, and BullMQ through it) that
 * verifies. `sslrootcert` is deliberately NOT set: pg reads it as a file path,
 * so libpq's `system` keyword would be an ENOENT here.
 */
export function verifiedPgConnectionString(databaseUrl: string): string {
  const { url, tls } = tlsFor(databaseUrl);
  if (!url || tls === 'off') return databaseUrl;
  url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

/**
 * A connection string for libpq tools (`pg_dump`, `pg_restore`, `psql`).
 * libpq's verify-full needs a root store, and without `sslrootcert` it looks
 * for `~/.postgresql/root.crt`; `system` (libpq 16+) means the OS store, which
 * is why the worker image installs `ca-certificates`. A server behind a private
 * CA (RDS) is trusted through libpq's own `PGSSLROOTCERT`, which a URL
 * parameter would override, so `system` is added only when that is unset. The
 * URL is the wrong place for it: postgres.js forwards unknown URL parameters to
 * the server as startup parameters.
 */
export function verifiedLibpqConnectionString(
  databaseUrl: string,
  env: Record<string, string | undefined> = process.env
): string {
  const { url, tls } = tlsFor(databaseUrl);
  if (!url || tls === 'off') return databaseUrl;
  url.searchParams.set('sslmode', 'verify-full');
  if (!url.searchParams.get('sslrootcert') && !env.PGSSLROOTCERT) {
    url.searchParams.set('sslrootcert', 'system');
  }
  return url.toString();
}
