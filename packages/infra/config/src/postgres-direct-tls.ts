import { isIP } from 'node:net';
import tls from 'node:tls';

/**
 * TLS for postgres.js without the in-band upgrade (SC-1440).
 *
 * postgres.js negotiates TLS the classic way: `SSLRequest` on a plain socket,
 * then `tls.connect({ socket })` over it. On Bun (1.4.2, measured 2026-09-29)
 * every reply chunk is ALSO queued on that plain socket's readable buffer,
 * which nothing reads, so each connection keeps every byte it has read until it
 * closes. One 5 MB SELECT sixteen times: `external` 11 → 84 MB. The history
 * backfill read ~15 MB per 30-day chunk and died on the worker's memory budget.
 * `pg` does not do this (flat over the same run), and a shorter `max_lifetime`
 * only bounds it.
 *
 * Opening TLS first (Postgres direct SSL, ALPN `postgresql`) and handing
 * postgres.js the finished socket leaves no plain socket to fill: flat at 6 MB
 * on Neon's direct and pooled hosts. Direct SSL needs Postgres 17 or a proxy
 * that speaks it, so it is used for Neon, or where the URL says
 * `sslnegotiation=direct`; every other server keeps the upgrade.
 *
 * The caller passes `postgresJsSsl(url)` in, so every connection site still
 * visibly goes through the SC-784 helper and this only decides HOW to open TLS,
 * never whether to verify.
 *
 * Its own subpath, not the barrel: `@scani/ui` imports the barrel, and
 * `node:tls` cannot reach a browser build.
 */

type DirectSocket = (o: { host: string[]; port: number[] }) => Promise<tls.TLSSocket>;

export function postgresJsTls(
  databaseUrl: string,
  ssl: false | 'verify-full',
  connectTimeoutMs = 10_000
): { ssl: false | 'verify-full'; socket?: DirectSocket } {
  if (ssl === false || !speaksDirectSsl(databaseUrl)) return { ssl };
  return { ssl: false, socket: directSocket(connectTimeoutMs) };
}

function speaksDirectSsl(databaseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return false;
  }
  // postgres.js hands the socket hook no host index, so it cannot follow a
  // multi-host URL's failover order.
  if (url.host.includes(',')) return false;
  return url.searchParams.get('sslnegotiation') === 'direct' || url.hostname.endsWith('.neon.tech');
}

function directSocket(connectTimeoutMs: number): DirectSocket {
  return ({ host, port }) =>
    new Promise((resolve, reject) => {
      const h = host[0] ?? 'localhost';
      const socket = tls.connect(
        {
          host: h,
          port: port[0] ?? 5432,
          servername: isIP(h) ? undefined : h,
          ALPNProtocols: ['postgresql'],
        },
        () => {
          clearTimeout(timer);
          resolve(socket);
        }
      );
      const timer = setTimeout(
        () =>
          socket.destroy(new Error(`TLS connect to ${h} timed out after ${connectTimeoutMs}ms`)),
        connectTimeoutMs
      );
      socket.once('error', (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
}
