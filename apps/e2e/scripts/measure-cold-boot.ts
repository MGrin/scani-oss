#!/usr/bin/env bun

/**
 * What a returning reader waits for between clicking a magic link and seeing
 * their net worth — measured as a request waterfall, against a real API.
 *
 * SC-130 fixed a double boot on this path and reported the remainder as a
 * five-deep serial chain (SC-163, SC-164). Its harness was not committed, so
 * the numbers could not be reproduced or improved against. This is that harness,
 * kept.
 *
 * `measure-bundle-tti.ts` answers a different question — how many bytes and how
 * long to first interactive control, against a stub API that 503s every data
 * call. That is the right shape for a byte-shaving change and the wrong one
 * here: the whole subject is which request waits for which, and a stub API has
 * no server time and no batching, so every dependency looks free.
 *
 * ## Running it
 *
 * ```
 * # 1. a scratch Postgres, migrated (never the shared :5433)
 * DATABASE_URL=postgres://postgres@127.0.0.1:5497/scani_test bun run db:migrate
 * cd apps/e2e && DATABASE_URL=... bun scripts/seed-cold-boot.ts
 *
 * # 2. the real api against it, on 3099 (apps/backend/api/.env)
 * cd apps/backend/api && bun run src/index.ts
 *
 * # 3. the real production build, pointed at the harness origin
 * cd apps/frontend/app && VITE_API_URL=https://127.0.0.1:4699 bun run build
 *
 * # 4. measure
 * cd apps/e2e && bun scripts/measure-cold-boot.ts --rtt 180 --label before
 * ```
 *
 * ## The five decisions that make two runs comparable
 *
 * 1. **Latency is emulated per request at the terminator**, one full round trip
 *    per request, exactly as SC-130 did it. It is not a bandwidth-shaped mobile
 *    link — this measures round trips, which is what the app is bound by
 *    (SC-132 measured 4183 ms to interactive with 0 ms of main-thread blocking).
 * 2. **The API is real**, on a scratch Postgres seeded with 20 holdings × 400
 *    days. `dashboard.getOverview` is a whole-portfolio valuation pass and its
 *    server time is a large part of what anything downstream of it waits for;
 *    stubbing it would hide the cost of depending on it.
 * 3. **Same origin, app and API**, for the reason `measure-bundle-tti.ts`
 *    already gives: a cross-origin API drags in CORS preflights whose timing
 *    varies with how they are cached, and that noise is larger than some of the
 *    hops being measured. Production is cross-site; the serial chain is not.
 * 4. **Service workers are blocked.** SC-130's own control row showed allowed
 *    and blocked within noise of each other once the double boot was fixed, and
 *    blocking removes a source of run-to-run variance that has nothing to do
 *    with the waterfall.
 * 5. **A fresh browser context per run, with the session cookie planted.** This
 *    is the returning reader whose device has been cleared — WebKit evicts
 *    script-writable storage after seven days, which is the ordinary state of
 *    the person clicking a magic link. `--warm-device` seeds the SC-78 last-user
 *    hint instead, which is the same reader inside seven days.
 *
 * **Known limits.** Bun serves HTTP/1.1 where Cloudflare serves HTTP/2, so
 * parallel fetches ride separate connections here. Both origins are 127.0.0.1,
 * so this is not cross-site the way `app.scani.xyz` ↔ `api.scani.xyz` is. Device
 * CPU is a laptop's. The absolute milliseconds are a floor, not a prediction of
 * production; the deltas between two runs of this script are the output.
 */

import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { type BrowserContext, chromium, webkit } from '@playwright/test';

const PORT = 4699;
const ORIGIN = `https://127.0.0.1:${PORT}`;
const API_UPSTREAM = process.env.COLD_BOOT_API ?? 'http://127.0.0.1:3099';
const DIST = process.env.COLD_BOOT_DIST ?? path.resolve(import.meta.dir, '../../frontend/app/dist');
const HARNESS_EMAIL = 'cold-boot@scani.local';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
};
const RTT = Number(flag('rtt', '180'));
const RUNS = Number(flag('runs', '3'));
const LABEL = flag('label', 'run');
const WARM_DEVICE = args.includes('--warm-device');
const ENTRY_PATH = flag('path', '/');
/**
 * Chromium by default. WebKit is the browser SC-130's double-boot finding was
 * about, but it refuses the harness's self-signed certificate outright — macOS
 * WebKit does not honour `ignoreHTTPSErrors` for it — and the waterfall being
 * measured here is not browser-specific. SC-130 published Chromium rows beside
 * its WebKit ones, so these numbers sit next to those.
 */
const BROWSER = flag('browser', 'chromium') === 'webkit' ? webkit : chromium;

/** The response the reader is waiting for: the net-worth series. */
const GOAL = 'portfolio.getNetWorthSeries';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function contentType(pathname: string): string {
  if (pathname.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (pathname.endsWith('.css')) return 'text/css; charset=utf-8';
  if (pathname.endsWith('.html')) return 'text/html; charset=utf-8';
  if (pathname.endsWith('.json')) return 'application/json; charset=utf-8';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  if (pathname.endsWith('.woff2')) return 'font/woff2';
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.webmanifest')) return 'application/manifest+json';
  return 'application/octet-stream';
}

const shouldCompress = (pathname: string) => /\.(js|css|html|json|svg|webmanifest)$/.test(pathname);

async function selfSignedCert(): Promise<{ cert: string; key: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'scani-cold-boot-tls-'));
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  const openssl = Bun.spawn(
    // biome-ignore format: one flag per line is unreadable for an openssl invocation
    ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
    { stdout: 'ignore', stderr: 'ignore' }
  );
  if ((await openssl.exited) !== 0) throw new Error('openssl could not generate a harness cert');
  return { cert: await Bun.file(certPath).text(), key: await Bun.file(keyPath).text() };
}

/**
 * Brotli at quality 11 over a 2 MB bundle costs the best part of a second of
 * server CPU, and it used to be paid lazily on the first request. That made
 * run 1 of every sweep ~1.9 s slower than runs 2 and 3 and the median a warm
 * number wearing a cold label. Compressing every asset before the browser
 * launches is what makes the runs comparable to each other.
 */
async function compressDist(): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const cache = new Map<string, Uint8Array<ArrayBuffer>>();
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel);
        continue;
      }
      const raw = new Uint8Array(await Bun.file(path.join(dir, entry.name)).arrayBuffer());
      cache.set(
        rel,
        shouldCompress(rel)
          ? new Uint8Array(
              brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } })
            )
          : raw
      );
    }
  };
  await walk(DIST, '');
  return cache;
}

function startTerminator(
  tls: { cert: string; key: string },
  cache: Map<string, Uint8Array<ArrayBuffer>>
) {
  return Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    tls,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);

      // One full round trip per request, paid before anything else happens —
      // the same shape as a terminator in front of both origins.
      await sleep(RTT);

      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/trpc')) {
        const upstream = new URL(url.pathname + url.search, API_UPSTREAM);
        const proxied = await fetch(upstream, {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
          // @ts-expect-error Bun accepts a duplex hint that the DOM types omit
          duplex: 'half',
          redirect: 'manual',
        });
        return proxied;
      }

      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const target = (await Bun.file(`${DIST}${pathname}`).exists()) ? pathname : '/index.html';

      const body = cache.get(target);
      if (!body) return new Response('not found', { status: 404 });

      const headers: Record<string, string> = {
        'content-type': contentType(target),
        'cache-control': target.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'max-age=0, must-revalidate',
      };
      if (shouldCompress(target)) headers['content-encoding'] = 'br';
      return new Response(body, { headers });
    },
  });
}

/**
 * A session cookie, obtained the way the app obtains one and then planted.
 *
 * Plain `fetch` rather than Playwright's request context: playwright-core's
 * Set-Cookie parser throws on this API's response under Bun (it is handed a
 * relative response URL), so the cookie is silently never stored and the call
 * appears to hang. Signing in out here and calling `addCookies` is the recipe
 * that works.
 *
 * The OTP is read out of the api's own stdout, because an api booted this way
 * has no email transport and prints the code instead of sending it.
 */
interface HarnessCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: true;
  httpOnly: true;
  sameSite: 'Lax';
}

/** The api rate-limits auth at 6 per IP per hour, and a measurement sweep is
 *  more runs than that. */
const COOKIE_CACHE = path.join(tmpdir(), 'scani-cold-boot-cookies.json');

async function sessionCookies(apiLogPath: string): Promise<HarnessCookie[]> {
  const cached = Bun.file(COOKIE_CACHE);
  if (await cached.exists()) {
    const probe = await fetch(`${API_UPSTREAM}/api/auth/get-session`, {
      headers: {
        cookie: ((await cached.json()) as HarnessCookie[])
          .map((c) => `${c.name}=${c.value}`)
          .join('; '),
      },
    });
    if (probe.ok && (await probe.text()).includes(HARNESS_EMAIL)) {
      return (await Bun.file(COOKIE_CACHE).json()) as HarnessCookie[];
    }
  }

  const before = (await Bun.file(apiLogPath).text()).length;
  const send = await fetch(`${API_UPSTREAM}/api/auth/email-otp/send-verification-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: HARNESS_EMAIL, type: 'sign-in' }),
  });
  if (!send.ok) throw new Error(`OTP send failed: ${send.status} ${await send.text()}`);

  let otp: string | undefined;
  for (let attempt = 0; attempt < 40 && !otp; attempt++) {
    await sleep(250);
    const tail = (await Bun.file(apiLogPath).text()).slice(before);
    // The LAST match: an earlier run's code reads as INVALID_OTP.
    const matches = [...tail.matchAll(/(\d{6}) — your sign-in code/g)];
    otp = matches[matches.length - 1]?.[1];
  }
  if (!otp) throw new Error('no OTP appeared in the api log');

  const signIn = await fetch(`${API_UPSTREAM}/api/auth/sign-in/email-otp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: HARNESS_EMAIL, otp }),
  });
  if (!signIn.ok) throw new Error(`OTP sign-in failed: ${signIn.status} ${await signIn.text()}`);

  // `secure` and `httpOnly` are not decoration: the session cookie carries the
  // `__Secure-` prefix, and Chromium rejects the whole `addCookies` call with
  // "Invalid cookie fields" if a `__Secure-` cookie is planted without it.
  const cookies: HarnessCookie[] = signIn.headers
    .getSetCookie()
    .map((raw) => raw.split(';')[0] ?? '')
    .filter((pair) => pair.includes('='))
    .map((pair) => {
      const eq = pair.indexOf('=');
      return {
        name: pair.slice(0, eq) as string,
        value: pair.slice(eq + 1),
        domain: '127.0.0.1',
        path: '/',
        secure: true as const,
        httpOnly: true as const,
        sameSite: 'Lax' as const,
      };
    });
  await Bun.write(COOKIE_CACHE, JSON.stringify(cookies));
  return cookies;
}

interface Event {
  at: number;
  kind: 'req' | 'res';
  label: string;
}

/** `/trpc/a.b,c.d?batch=1&input=…` → `a.b,c.d`. Everything else keeps its path. */
function label(url: string): string {
  const parsed = new URL(url);
  if (parsed.pathname.startsWith('/trpc/')) return parsed.pathname.slice('/trpc/'.length);
  return parsed.pathname;
}

async function measureOnce(context: BrowserContext): Promise<{ events: Event[]; goalMs: number }> {
  const page = await context.newPage();
  // The service worker is out of scope here — SC-130 removed its effect and its
  // control row showed blocked and allowed within noise afterwards.
  await page.route('**/sw.js', (route) => route.abort());

  // A fresh BrowserContext is NOT a cold cache: Chromium's HTTP cache is
  // per-browser, so run 2 of any sweep loaded the bundle from disk and came
  // back in a third of the time. Every run must clear it, or the median
  // reported is the warm number wearing the cold one's label.
  if (BROWSER === chromium) {
    const client = await page.context().newCDPSession(page);
    await client.send('Network.enable');
    await client.send('Network.clearBrowserCache');
  }

  const events: Event[] = [];
  let start = 0;
  page.on('request', (request) => {
    events.push({ at: Date.now() - start, kind: 'req', label: label(request.url()) });
  });
  page.on('response', (response) => {
    events.push({ at: Date.now() - start, kind: 'res', label: label(response.url()) });
  });

  start = Date.now();
  await page.goto(`${ORIGIN}${ENTRY_PATH}`, { waitUntil: 'commit' });
  // The chart's own container, which cannot render before the series answers.
  await page.waitForResponse((response) => response.url().includes(GOAL), { timeout: 60_000 });
  const goalMs = events.filter((e) => e.kind === 'res' && e.label.includes(GOAL)).at(-1)?.at ?? -1;

  await page.close();
  return { events, goalMs };
}

const tls = await selfSignedCert();
const server = startTerminator(tls, await compressDist());
const apiLog = process.env.COLD_BOOT_API_LOG ?? `${process.env.TMPDIR}sc164/api.log`;
const cookies = await sessionCookies(apiLog);
if (cookies.length === 0) throw new Error('sign-in returned no cookies');

const browser = await BROWSER.launch();
const results: number[] = [];
let lastEvents: Event[] = [];

for (let run = 0; run < RUNS; run++) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.addCookies(cookies);
  if (WARM_DEVICE) {
    await context.addInitScript(() => {
      try {
        localStorage.setItem(
          'scani.auth.last-user',
          JSON.stringify({ id: 'cold-boot', email: 'cold-boot@scani.local' })
        );
      } catch {
        // Private mode degrades the same way the app does.
      }
    });
  }
  const { events, goalMs } = await measureOnce(context);
  results.push(goalMs);
  lastEvents = events;
  await context.close();
}

await browser.close();
server.stop(true);

console.log(`\n=== ${LABEL} — ${RTT} ms RTT, ${RUNS} run(s)${WARM_DEVICE ? ', warm device' : ''}`);
console.log('\nwaterfall (last run, ms from navigation):');
for (const event of lastEvents) {
  console.log(`${String(event.at).padStart(6)}  ${event.kind}  ${event.label}`);
}
const sorted = [...results].sort((a, b) => a - b);
console.log(`\ntime to ${GOAL}: ${results.join(', ')} ms`);
console.log(`median ${sorted[Math.floor(sorted.length / 2)]} ms`);
process.exit(0);
