/**
 * What a cold visitor actually waits for, measured rather than argued about.
 *
 * SC-132 established that `app.scani.xyz` costs **4183 ms to first interactive
 * control** on Slow 4G with a 4x CPU handicap, of which **0 ms is main-thread
 * blocking** — it is download, start to finish. That makes bytes the only lever,
 * and it makes any claim about a byte-shaving change unfalsifiable unless the
 * same profile can be re-run on demand. This is that profile.
 *
 * Run it against a `dist/` built for the harness:
 *
 * ```
 * cd apps/frontend/app && VITE_API_URL=https://127.0.0.1:4599 bun run build
 * cd apps/e2e && bun run perf:tti --label before
 * ```
 *
 * Four decisions worth knowing, because each one is why a number here is
 * comparable to the next number here:
 *
 * 1. **The API is same-origin, served by this script.** The alternative — a real
 *    or a Playwright-intercepted API on another origin — drags in CORS preflights
 *    whose timing varies with how the interception is implemented. Serving the
 *    stub from the same Bun server as the assets removes that variable entirely.
 *    It is why the build has to name `https://127.0.0.1:4599`.
 * 2. **TLS, with a throwaway self-signed certificate.** Not for realism: a
 *    production build asserts `VITE_API_URL` is https and *throws before
 *    rendering anything* if it is not (`assertFrontendEnv`), so a cleartext
 *    harness measures a blank page. The certificate is generated once into
 *    `$TMPDIR` and the browser is told to ignore it.
 * 3. **Assets are brotli-compressed and served with production cache headers**,
 *    because the number that matters is wire bytes on a first visit, and
 *    Cloudflare Pages sends brotli. Measuring uncompressed output would flatter
 *    or punish a change depending on how compressible the code it moved was.
 * 4. **Both scenarios are measured.** `signed-out` is the true cold entry and is
 *    what the review reported; `signed-in` mounts the actual application shell.
 *    A route-level split looks far better than it is on `signed-out` alone,
 *    because a signed-out visitor never reaches either UI generation — so
 *    reporting only that number would overstate the win. `signed-in` is the
 *    honest one.
 *
 * **Known difference from production**: Bun serves HTTP/1.1, Cloudflare serves
 * HTTP/2. Parallel chunk fetches therefore ride separate connections here rather
 * than one multiplexed one. It costs the split *more* than production would, so
 * a win measured here is not an artefact of the harness.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib';
import { chromium, type Page } from '@playwright/test';

const PORT = 4599;
const ORIGIN = `https://127.0.0.1:${PORT}`;

/**
 * Chrome DevTools' own "Slow 4G" and "Fast 4G" constants, and a 4x CPU
 * handicap. These are the exact figures behind the review's table, so a number
 * produced here sits beside the ones already published rather than beside
 * nothing.
 */
const PROFILES = {
  'slow-4g': { download: 180_000, upload: 84_375, latency: 562.5, cpu: 4 },
  'fast-4g': { download: 1_012_500, upload: 1_012_500, latency: 75, cpu: 4 },
  none: { download: -1, upload: -1, latency: 0, cpu: 1 },
} as const;

type ProfileName = keyof typeof PROFILES;

interface Scenario {
  name: 'signed-out' | 'signed-in';
  path: string;
  /** The first control a reader can actually press. */
  readySelector: string;
  session: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  // The sign-in form's submit button. A visitor with no session is redirected
  // here from `/`, so this is the cold entry the review measured.
  {
    name: 'signed-out',
    path: '/',
    readySelector: 'button[type="submit"]',
    session: false,
  },
  // v3's tab bar. It belongs to `V3Shell`, so it cannot paint until the UI
  // generation itself has loaded — which is the whole point of measuring it.
  {
    name: 'signed-in',
    path: '/',
    readySelector: 'nav[aria-label="Primary"]',
    session: true,
  },
];

const SESSION_USER = {
  id: 'perf-harness-user',
  email: 'perf@scani.local',
  name: 'Perf Harness',
  emailVerified: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function contentType(pathname: string): string {
  if (pathname.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (pathname.endsWith('.css')) return 'text/css; charset=utf-8';
  if (pathname.endsWith('.html')) return 'text/html; charset=utf-8';
  if (pathname.endsWith('.json')) return 'application/json; charset=utf-8';
  if (pathname.endsWith('.svg')) return 'image/svg+xml';
  if (pathname.endsWith('.woff2')) return 'font/woff2';
  if (pathname.endsWith('.woff')) return 'font/woff';
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.webmanifest')) return 'application/manifest+json';
  return 'application/octet-stream';
}

/** Fonts and images are already compressed; brotli-ing them again costs CPU and
 *  saves nothing, which is also what Cloudflare does. */
function shouldCompress(pathname: string): boolean {
  return /\.(js|css|html|json|svg|webmanifest)$/.test(pathname);
}

/** A throwaway certificate for 127.0.0.1, made once per invocation. Only here
 *  because the production bundle refuses to boot against a cleartext API URL. */
async function selfSignedCert(): Promise<{ cert: string; key: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'scani-perf-tls-'));
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  const openssl = Bun.spawn(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=127.0.0.1',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdout: 'ignore', stderr: 'ignore' }
  );
  if ((await openssl.exited) !== 0) throw new Error('openssl could not generate a harness cert');
  return {
    cert: await Bun.file(certPath).text(),
    key: await Bun.file(keyPath).text(),
  };
}

function startServer(dist: string, session: boolean, tls: { cert: string; key: string }) {
  const cache = new Map<string, Uint8Array<ArrayBuffer>>();

  return Bun.serve({
    port: PORT,
    hostname: '127.0.0.1',
    tls,
    async fetch(request) {
      const url = new URL(request.url);

      // Better-Auth's session probe. `signed-out` answers `null` rather than
      // failing: AuthContext treats an unanswered probe as `unreachable` and
      // renders an offline screen, which is a different page with different
      // timing (SC-78).
      if (url.pathname.startsWith('/api/auth/')) {
        const body = session
          ? { session: { token: 'perf-harness', userId: SESSION_USER.id }, user: SESSION_USER }
          : null;
        return Response.json(body);
      }

      // Every data call fails, identically, in both the before and the after
      // run. Pages render their handled error states; nothing crashes into an
      // error boundary and takes the shell — and therefore the element being
      // timed — off the screen with it.
      if (url.pathname.startsWith('/trpc')) {
        return new Response('perf harness: no backend', { status: 503 });
      }

      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = Bun.file(`${dist}${pathname}`);
      const target = (await file.exists()) ? pathname : '/index.html';

      let body = cache.get(target);
      if (!body) {
        const raw = new Uint8Array(await Bun.file(`${dist}${target}`).arrayBuffer());
        body = shouldCompress(target)
          ? new Uint8Array(
              brotliCompressSync(raw, {
                params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
              })
            )
          : raw;
        cache.set(target, body);
      }

      // What Cloudflare Pages sends: hashed assets are immutable, the entry
      // document never is.
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

interface RunResult {
  interactiveMs: number;
  fcpMs: number;
  wireBytes: number;
  jsBytes: number;
  jsRequests: number;
  blockingMs: number;
}

/**
 * What a signed-in device already has on disk when the JS cache does not.
 *
 * The dominant cold load is not a first-ever visit — it is a **returning reader
 * after a deploy**: hashed assets change so every byte is re-fetched, while
 * `localStorage` and the session cookie survive untouched. Seeding the SC-78
 * "last user" hint is what makes the `signed-in` scenario that load rather than
 * a device that has somehow never stored anything, and it is the signal
 * `warmUiVersion` reads to decide whether to warm a generation's chunk at all.
 */
async function seedReturningDevice(page: Page): Promise<void> {
  await page.addInitScript((user) => {
    try {
      localStorage.setItem('scani.auth.last-user', JSON.stringify(user));
    } catch {
      // Private mode. The app degrades the same way.
    }
  }, SESSION_USER);
}

async function measureOnce(page: Page, scenario: Scenario, profile: ProfileName) {
  const client = await page.context().newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.clearBrowserCache');

  const bytesByRequest = new Map<string, { url: string; bytes: number }>();
  client.on('Network.requestWillBeSent', (event) => {
    bytesByRequest.set(event.requestId, { url: event.request.url, bytes: 0 });
  });
  client.on('Network.loadingFinished', (event) => {
    const entry = bytesByRequest.get(event.requestId);
    // `encodedDataLength` is bytes on the wire. The review's own correction was
    // that Resource Timing reports service-worker-mediated *decoded* sizes and
    // will happily claim 2 MB arrived in 113 ms over a 1.6 Mbps link.
    if (entry) entry.bytes = event.encodedDataLength;
  });

  const p = PROFILES[profile];
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: p.download,
    uploadThroughput: p.upload,
    latency: p.latency,
  });
  await client.send('Emulation.setCPUThrottlingRate', { rate: p.cpu });

  await page.addInitScript(() => {
    const w = window as unknown as { __perfBlocking: number };
    w.__perfBlocking = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__perfBlocking += Math.max(0, entry.duration - 50);
    }).observe({ type: 'longtask', buffered: true });
  });

  await page.goto(`${ORIGIN}${scenario.path}`, { waitUntil: 'commit' });
  await page.waitForSelector(scenario.readySelector, { state: 'visible', timeout: 60_000 });

  // Read the clock inside the document so the figure is relative to this
  // navigation's start, not to whenever the driver got around to asking.
  const timings = await page.evaluate(() => {
    const paint = performance.getEntriesByName('first-contentful-paint')[0];
    return {
      now: performance.now(),
      fcp: paint ? paint.startTime : 0,
      blocking: (window as unknown as { __perfBlocking: number }).__perfBlocking,
    };
  });

  const entries = [...bytesByRequest.values()];
  const js = entries.filter((e) => e.url.endsWith('.js'));

  const result: RunResult = {
    interactiveMs: Math.round(timings.now),
    fcpMs: Math.round(timings.fcp),
    wireBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
    jsBytes: js.reduce((sum, e) => sum + e.bytes, 0),
    jsRequests: js.length,
    blockingMs: Math.round(timings.blocking),
  };
  await client.detach();
  return result;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const low = sorted[mid - 1];
  const high = sorted[mid];
  if (high === undefined) return 0;
  return sorted.length % 2 === 0 && low !== undefined ? Math.round((low + high) / 2) : high;
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value ?? fallback;
}

const dist = arg('dist', new URL('../../frontend/app/dist', import.meta.url).pathname);
const label = arg('label', 'run');
const runs = Number(arg('runs', '4'));
const profile = arg('profile', 'slow-4g') as ProfileName;

if (!PROFILES[profile]) {
  console.error(`unknown profile "${profile}" — one of ${Object.keys(PROFILES).join(', ')}`);
  process.exit(1);
}
if (!(await Bun.file(`${dist}/index.html`).exists())) {
  console.error(`no build at ${dist} — run the app's \`bun run build\` first`);
  process.exit(1);
}

const tls = await selfSignedCert();
const browser = await chromium.launch();
const rows: string[] = [];

for (const scenario of SCENARIOS) {
  const server = startServer(dist, scenario.session, tls);
  const results: RunResult[] = [];

  for (let run = 0; run < runs; run++) {
    // A fresh context per run, so nothing — cache, storage, service worker —
    // survives from the previous one. The whole cost being measured is a first
    // visit; the review's warm figure was 343 ms and 0 bytes of JS.
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      serviceWorkers: 'block',
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    try {
      if (scenario.session) await seedReturningDevice(page);
      results.push(await measureOnce(page, scenario, profile));
    } finally {
      await context.close();
    }
  }

  await server.stop(true);

  const first = results[0];
  if (!first) continue;
  const interactive = results.map((r) => r.interactiveMs);
  rows.push(
    [
      `${label} · ${scenario.name}`,
      `${median(interactive)} ms`,
      `${Math.min(...interactive)}–${Math.max(...interactive)} ms`,
      `${median(results.map((r) => r.fcpMs))} ms`,
      kb(median(results.map((r) => r.wireBytes))),
      kb(median(results.map((r) => r.jsBytes))),
      `${first.jsRequests}`,
      `${median(results.map((r) => r.blockingMs))} ms`,
    ].join(' | ')
  );
}

await browser.close();

console.log(`\nprofile: ${profile} · runs: ${runs} · dist: ${dist}\n`);
console.log('scenario | interactive (median) | spread | FCP | wire | JS | JS reqs | blocking');
console.log('---|---|---|---|---|---|---|---');
for (const row of rows) console.log(row);
console.log('');
