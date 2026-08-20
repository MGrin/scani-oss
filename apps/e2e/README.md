# @scani/e2e

End-to-end test suite for Scani. See CONTRIBUTING.md for the test-suite overview.

Quick start:
  bun install
  bun run test:e2e:install   # one-time Playwright browser download
  cd ../.. && bun test:e2e   # boots stack (if needed), runs suite, tears down

## Viewports

`fixtures/devices.ts` is the single viewport matrix, consumed by both
`playwright.config.ts` (as projects) and `scripts/shots.ts` (as browser
contexts):

| Project | Device | Size | Engine |
|---|---|---|---|
| `chromium` | Desktop Chrome | 1280×720 | chromium |
| `webkit` | Desktop Safari | 1280×720 | webkit |
| `iphone` | iPhone 15 Pro | 393×852 | webkit |
| `ipad` | iPad Mini | 768×1024 | webkit |

`bun test:e2e` runs the two desktop projects only — v2 is a desktop layout, so
running every spec at 393px would report layout noise as failures. Point a spec
at a phone on demand:

```bash
cd apps/e2e && bunx playwright test --project=iphone tests/holdings
```

## Rate-limit isolation — why specs import `test` from `fixtures/test`

The api rate-limits inbound requests per client IP. Nothing sits in front of the
compose stack, so `defaultInflowKey` falls all the way through to
`user-agent|origin|method` — one identity for every test in a Playwright
project, sharing one 300-request/minute bucket. `waitForJob` polls four times a
second and `workers: 4` runs four tests at once, so the suite aimed roughly 960
requests a minute at a 300/minute budget. Which test got the 429 depended only
on what its siblings had already spent, which is why the failing set was
different every run and why six CI runs across two branches could not agree on a
cause (SC-489).

Every test now carries a User-Agent of its own — the project's, with an
identity appended as a product token — so each gets the whole budget alone. It
rides on the UA rather than a header of its own for a reason: the SPA's calls to
the api are cross-origin, so a custom request header turns every one of them
into a preflight the api's `allowedHeaders` does not permit, and the app stops
being able to fetch its own session. That is not theoretical; it is what the
first attempt at this did.

Three rules keep it true; `tests/lib/rate-limit-isolation.spec.ts` enforces the
first two:

1. Import `test` and `expect` from `../../fixtures/test`, never from
   `@playwright/test`. That import is what attaches the identity.
2. A context built by hand — `browser.newContext()` — needs
   `isolatedContextOptions(testInfo)`, spread *after* any device descriptor.
   The `context` fixture's options do not reach it.
3. Nothing retries a 429 and nothing flushes another test's budget. This makes
   the limiters *isolated*, not lenient: every cap is still enforced exactly as
   configured, and `tests/auth/auth-rate-limit.spec.ts` asserts one of them
   fires — coverage the suite did not have while it was quietly retrying past
   them.

## Accessibility gate — `tests/a11y`

The §2.6 floor of the v3 research brief, enforced on every v3 surface. Runs in
CI as the `Accessibility gate & mobile smoke` job, on the same stack boot as
the mobile smoke run:

```bash
cd apps/e2e
bun run test:e2e:a11y   # boots the stack, runs tests/a11y + tests/smoke, tears down
```

Two projects, because the v3 mobile shell (tab bar + drawer) and the desktop
shell (sidebar) are different trees — a scan of one has not scanned the other.

What it checks, and what checks it:

| §2.6 row | Checked by |
|---|---|
| Text contrast, non-text contrast | `@axe-core/playwright`, `wcag2a…wcag22aa` tags, failing on `critical` **and** `serious` (contrast reports as serious, so a critical-only gate would gate nothing) |
| Focus visible, accessible names, keyboard reachability | same axe pass |
| Touch targets ≥ 44×44 | `measureUndersizedTargets` — measured from `getBoundingClientRect`, phone project only, because the v3 token layer spends `--tap-target` behind `pointer: coarse` |
| Minimum 16px on text entry | `measureSmallInputs` — computed `font-size`, every project |
| Colour never alone | not here: nothing in the DOM tells "red because loss" from "red because brand". `<Numeric>` enforces it and `apps/frontend/app/tests/v3/` asserts it |

Two properties worth knowing before editing it:

- **It accumulates before it asserts.** A gate that stops at the first bad
  route takes as many runs to clear as there are problems, and each run costs a
  stack boot. One failure prints every offender, with the failing element's
  markup — a Radix `button[aria-controls="radix-:r13:"]` selector names nothing.
- **It asserts it measured something.** "No offenders" is also what a walk that
  rendered nothing returns. `Measured.scanned` is what makes a pass mean the
  screens were there.

The route list is `fixtures/v3-routes.ts`, and it is not allowed to drift:
`apps/frontend/app/tests/v3/a11y-coverage.test.ts` reads that file and fails
when a `V3_NAV_PATHS` destination is missing from it. A new v3 surface cannot
skip the gate by being forgotten.

## Signing in to a local stack from a browser

Three v3 threads each concluded local browser auth was impossible and built a
throwaway workaround instead (two temporary Vite entry points, one reverse
proxy). It works. This is the recipe.

```bash
# 1. Infrastructure. Already running is fine — these are shared across worktrees.
docker compose up -d postgres redis mailpit minio

# 2. Env. There is no committed .env; nothing tells you to create one.
cp .env.example .env
bun scripts/sync-env.ts
bun run db:migrate

# 3. Backends. data-provider is NOT optional: the api routes email through it,
#    so without it every magic-link request answers 500.
cd apps/backend/data-provider && bun dev     # :8082
cd apps/backend/api           && bun dev     # :3001

# 4. Frontend.
cd apps/frontend/app && bun run vite --port 5173 --strictPort
```

Then sign in. The app uses magic-link auth, and dev mail lands in Mailpit:

```bash
# 1. Open http://localhost:5173/auth and submit any @scani.local address.
# 2. Pull the link out of Mailpit:
ID=$(curl -s "http://localhost:8026/api/v1/messages?limit=1" \
     | grep -o '"ID":"[^"]*"' | head -1 | cut -d'"' -f4)
curl -s "http://localhost:8026/api/v1/message/$ID" \
     | grep -oE 'http://localhost:3001/api/auth/magic-link/verify[^"<> \\]*' | head -1
# 3. Open that URL, then http://localhost:5173/
```

Verify with `fetch('http://localhost:3001/api/auth/get-session', {credentials:'include'})`
in `browser_eval` — it should return your email.

### The traps, in the order they bite

- **`curl http://localhost:3001/health` shows no `Access-Control-Allow-Origin`,
  and that is correct.** A request with no `Origin` header gets no allow-origin
  header — that is the CORS spec, not a broken plugin. This single observation
  is what convinced three threads the api emitted no CORS headers at all. Always
  pass `-H "Origin: http://localhost:5173"` when checking CORS by hand.
- **The page origin must be one the api allows.** Production allows exactly
  `FRONTEND_URL`. Dev additionally allows any loopback origin on any port
  (`apps/backend/api/src/config/browser-origins.ts`), so `127.0.0.1:5173` and a
  second worktree's Vite on another port both work. A mismatch surfaces only as
  `TypeError: Failed to fetch` in the browser console, with nothing at all in
  the api log.
- **Cookies are per-host, and `localhost` is not `127.0.0.1`.** Sign in and
  browse on the same one, or the session cookie set by the magic-link callback
  is not sent back.
- **Vite's cold start is ~15s** (5s boot plus first-request dep optimisation),
  which is longer than `browser_open`'s 20s navigation budget on a slow machine.
  Warm it with `curl` once before pointing the browser at it.
- **Ports collide across worktrees.** `lsof -nP -iTCP:5173 -sTCP:LISTEN` before
  trusting a screenshot; `--strictPort` so Vite fails loudly instead of quietly
  taking 5174.

## Screenshot harness — `bun run shots`

The edit → look loop against a **local** stack. Signs in, seeds a fixed
portfolio, walks a route list, and writes PNGs an agent can `Read`.

```bash
bun dev:stack                    # repo root — the harness needs api + app + worker
bun run shots                    # iphone + ipad, default routes
bun run shots -- --routes=/v3 --devices=iphone
```

Output lands in `apps/e2e/shots/<device>/<route>.png` (gitignored). The
directory is wiped at the start of each run, so what's there is always the
current run.

| Flag | Default | Effect |
|---|---|---|
| `--devices=` | `iphone,ipad` | Comma-separated names from the table above |
| `--routes=` | dashboard, holdings, accounts, institutions, vaults, groups, payments, add-data, settings | Comma-separated app routes |
| `--out=` | `shots` | Output directory, relative to `apps/e2e` |
| `--viewport` | off (full-page) | Capture only the visible viewport |
| `--settle=` | `1200` | Milliseconds to wait after load before the shot |
| `--fresh` | off | New user + new seed instead of reusing the stored session |

Layout: `scripts/shots.ts` is a Bun CLI wrapper that shells out to the
Playwright runner with `playwright.shots.config.ts` (its own `testDir`,
`capture/`, and its own globalSetup in `fixtures/shots-setup.ts`, which signs in
and seeds). The capture itself must run under the runner — under Bun,
`page.request`'s `Set-Cookie` parsing throws `ERR_INVALID_URL` on the relative
URLs Better-Auth returns, which breaks `fixtures/auth.ts`. The runner executes
under Node, where those fixtures already work for the whole spec suite.

The seeded portfolio (`PORTFOLIO` in `fixtures/shots-setup.ts`) is deliberately fixed
and fiat-only — identical data across runs is what makes two screenshot sets
comparable, and the fiat tokens ship in migration `0000` rather than arriving
from a CoinGecko sync a local stack may not have run.

The session is cached in `apps/e2e/.shots-session.json` (gitignored) and reused
until it stops working. That is not an optimisation: the API rate-limits
sign-ins to 6 per IP per hour, so re-authenticating on every run would lock the
harness out after a handful of invocations. `--fresh` when you want a clean
account.

Baselines are deliberately *not* part of this: macOS-rendered PNGs will never
match `ubuntu-latest`. If this grows into `toHaveScreenshot` regression
testing, baselines must be generated in CI only, inside the Playwright Docker
image, and updated one branch at a time.
