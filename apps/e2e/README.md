# @scani/e2e

End-to-end test suite for Scani. See CONTRIBUTING.md for the test-suite overview.

Quick start:
  bun install
  bun run test:e2e:install   # one-time Playwright browser download
  cd ../.. && bun test:e2e   # boots stack (if needed), runs suite, tears down

## The stack a run owns — and the one it must not touch

`scripts/run.ts` names its compose project explicitly, and the name is this
checkout's: `scani_<label>_<digest>_e2e`, derived in `scripts/lib/worktree.ts`
from the checkout path, next to the names its dev stack and its database carry
(SC-491, SC-493). It publishes on the host ports that checkout owns — the
documented ones in a primary checkout, offset in a linked worktree — and passes
them, and the URLs they imply, down to `wait-for-stack.ts`,
`playwright.config.ts` and the fixtures.

This is not tidiness. Compose names an unnamed project after the directory
leaf, which is `scani` in **every** bb worktree and in the primary checkout, so
a run used to compose against whichever stack was already up — and it tears its
own stack down with `down -v`. `-v` removes volumes: pointed at a project the
run did not create, it does not restart somebody's Postgres, it deletes their
database.

Two consequences worth knowing:

- The e2e project is deliberately **not** the dev-stack project of the same
  checkout, so the `down -v` at the end of a run can only ever remove volumes
  that run created. A dev stack and a Mode B e2e run cannot both be up in one
  checkout — they publish the same ports, and that collision is loud.
- `COMPOSE_PROJECT_NAME`, any `*_HOST_PORT`, `PLAYWRIGHT_BASE_URL`,
  `API_BASE_URL`, `DATA_PROVIDER_URL` and `MAILPIT_URL` already in the
  environment win. CI sets a project name for the whole job; an operator
  driving several stacks by hand has a reason.

Mode A ("reusing an already-running stack") is decided by probing this
checkout's api port, so a stack another worktree happens to be running on the
documented ports is no longer mistaken for this one's.

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

### `--project=name`, never `--project name` (SC-533)

Playwright declares `--project` as **variadic**, so the space-separated form
keeps consuming argv until it meets a flag — and a trailing spec path is read
as one more project *name*:

```bash
playwright test --project chromium tests/holdings/add-manual-holding.spec.ts
# Error: Project(s) "tests/holdings/add-manual-holding.spec.ts" not found.
```

The `=` ends the variadic, so the path arrives as the positional filter it is.
`scripts/run.ts` emits its own defaults that way, which is what makes this work:

```bash
bun run test:e2e tests/holdings/add-manual-holding.spec.ts
```

Pass `--project` in the space form yourself with a path after it and the runner
**refuses before booting the stack**, naming `--project=`. Playwright would
otherwise say the same thing at the far end of a compose build and a health
wait, about a project you never typed.

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

## Job waits — why `waitForJob` extends the test's timeout

Every spec that enqueues a worker job waits on it through `waitForJob` in
`fixtures/ui.ts`, which polls `trpc/jobs.status` until the job is `completed`
or `failed`. Two deadlines are in play, and until SC-498 the wrong one always
won.

`playwright.config.ts` sets no `timeout`, so a test gets Playwright's 30s
default. `waitForJob` also defaulted to 30s — and it starts some seconds into
the test, so its deadline could never be reached. Playwright's fired first, at
whichever `await` the fixture happened to be sitting on, and reported `Test
timeout of 30000ms exceeded` against a line of `fixtures/ui.ts`. That message
names test plumbing, so on a contended laptop a red run read as a product
failure while the only thing that had happened was a worker not finishing in
time. Two threads spent their time establishing that.

The same arithmetic silently voided every caller who had already diagnosed it
and asked for longer — 45s in `imports/csv-import`, 60s in
`imports/screenshot-parse`, 90s in `wallet-import/import-flow`, 120s in
`a11y/v3-accessibility`. Not one of those numbers could be reached.

So `waitForJob` now reserves its own budget out of the test's, by raising
`testInfo.timeout` by the wait plus a margin before it starts polling. The
fixture's deadline is therefore always the one that fires, whatever a caller
asks for, and the message it prints names the last state the job was actually
observed in:

- **`queued`** at the deadline — nothing picked the job up. No product code
  ran, so nothing in the spec's assertions was ever reached; look at the
  worker.
- **`active` / `progress`** — a worker took it and neither finished nor failed
  it. The message stops there on purpose. A contended box and a processor stuck
  in a loop are the same state from here, and a message that told you to
  dismiss it is how a real regression gets absorbed into a known flake.

`tests/lib/job-wait-budget.spec.ts` enforces both halves: that the fixture
outlives the budget it was given, and that the `active` message draws no
conclusion. Neither test needs a browser or a job — they stub the one call
`waitForJob` makes.

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
# 1. Infrastructure. NOT shared across checkouts (SC-491): a bare `docker
#    compose up` takes its project name from the directory leaf — `scani`
#    everywhere — so it adopts whatever stack is already running under that
#    name. Start this checkout's own stack the way the root README documents,
#    and read the ports it prints rather than assuming the ones below.
docker compose up -d postgres redis mailpit minio

# 2. Env. `.env` is not committed; sync-env.ts writes it from .env.example
#    on a fresh checkout and leaves an existing one alone.
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

No baselines here: this harness renders on whatever machine runs it, and a
macOS-rendered PNG is not comparable to anything. Pixel assertions are the next
section's job.

## Visual regression — `bun run visual`

Eight committed baselines, asserted pixel-for-pixel. Where `shots` is a loop
for a person, this is a gate: it fails a run when a screen changed and nobody
said it should.

```bash
bun dev:stack                 # repo root — same prerequisite as `shots`
cd apps/e2e
bun run visual                # assert against the committed baselines
bun run visual -- --update    # regenerate them (see the discipline below)
bun run visual -- --screen=holdings-phone
```

| Flag | Effect |
|---|---|
| `--update` | Regenerate baselines instead of asserting against them |
| `--screen=` | Run one screen; the names are in `visual/screens.ts` |
| `--keep-server` | Leave the browser container up after the run |

### Every pixel is rendered in a container, and that is the whole design

The ticket (SC-24) said baselines had to be generated *in CI*, inside the
Playwright Docker image, because macOS and `ubuntu-latest` do not rasterise the
same text. The reasoning was right and the mechanism is gone — GitHub Actions is
billing-blocked account-wide (SC-128, SC-414). But the requirement was never CI.
It was **a deterministic Linux renderer**, and that is a container, which runs
here today.

So `scripts/visual.ts` starts `playwright run-server` inside
`mcr.microsoft.com/playwright:v<version>-noble`, points the runner at it over
`connectOptions`, and tears it down. There is deliberately **no host fallback**:
`fixtures/visual-setup.ts` throws when `PW_VISUAL_WS` is unset, because a
baseline rendered by whatever Chromium is on a laptop is exactly the artefact
this replaces.

That claim was measured rather than assumed, on an aarch64 host against
`v1.60.0-noble`, in three steps:

1. One screen, four captures, **two separate containers** — four PNGs with a
   single sha256 between them. Identical, not "within tolerance".
2. All five baselines re-asserted from a fresh container at `maxDiffPixels: 0`.
3. All five re-asserted again after `VISUAL_FRESH=1` — a **new user and a new
   seed**, so what the baselines describe is the seed's content and not one
   database's rows.

**`VISUAL_FRESH=1` costs a third of the hour's auth budget, every time.** It
signs in *two* users — the seeded session and the empty one — against an api
that rate-limits auth to **6 per IP per hour**, so three fresh runs in an hour
is the whole allowance. Past it, `globalSetup` dies before a single screen is
photographed:

```
Error: OTP request failed: 429 {"error":"Too Many Requests", …,"retryAfterSec":378}
  at fixtures/auth.ts:25
```

That is a **budget, not an auth bug**, and it is worth knowing which because the
run it kills produced zero captures and zero comparisons. A fresh-seed
verification that ends this way has not passed and has not failed — it has not
happened, and the other runs in the batch say nothing about it.

SC-473 re-ran steps 1 and 2 for the three home screens it added, on a different
host and a different stack: generated once, then asserted twice from containers
started fresh each time, byte-identical both times.

That is why `toHaveScreenshot` runs at zero tolerance rather than at a guessed
threshold, and it is worth re-running rather than trusting if you change the
image tag or the host's architecture.

The other half of the claim was checked too: an injected defect is caught. A
4px change to the default button height went red on both desktop baselines with
a legible diff, and swapping the destructive alert's colour to a `warning` that
does not exist in the preset — the exact defect this is aimed at — went red on
both kitchen-sink baselines while the other three stayed green.

Three things that are not obvious:

- **The image tag is derived from the installed `playwright-core`**, not from
  the range in `package.json`. Playwright refuses to connect across a version
  mismatch, and a tag written by hand is a tag that goes stale on the next bump.
- **The host's `node_modules/playwright` is mounted into the container** rather
  than installed there. Same package by construction, and a run needs no npm
  registry. It also means the visual gate needs no `playwright install` on the
  host — the browsers it uses are the image's.
- **The browser reaches the stack through the client, not through Docker.**
  `exposeNetwork: '<loopback>'` tunnels the container's `localhost` requests back
  to this machine, which is the only arrangement where the address the browser
  uses is the `localhost:<port>` this checkout publishes the app on — what the
  SPA is built against and what its session cookie is scoped to. A compose
  network would need neither of those to be true, and both are.
- **The port is this checkout's, not the documented default.** `scripts/visual.ts`
  derives it through `scripts/lib/worktree.ts`, the same way `scripts/run.ts`
  does (SC-491, SC-495). Without that, a run from a linked worktree did not fail
  to find a stack — it found the primary checkout's, signed in against it and
  seeded a portfolio into somebody else's database.

### Which screens, and why those

`visual/screens.ts` is the list, and every entry carries the defect class it is
there to catch. The set is small on purpose: a screenshot per route is not the
goal. These are the classes it is aimed at, all four of which reached `main` and
were found by a person looking at a browser rather than by the suite — an
invisible callout (`warning` is not a colour in the preset), a 40px control on a
44px row, two Cancel buttons 80px apart, a heading over a contradicting count.

The rule for exclusion matters as much. **A screen whose content is not a
function of the seed does not belong here.** An untrusted baseline gets
`--update`d away, which is worse than no baseline, because it also costs the
review the diff.

Home was excluded under that rule until SC-473, on the reasoning that its hero
is a net-worth chart whose x-axis is dated from the seeded account's own age, so
its baseline would go red every day by itself. That was wrong, and the correction
is worth knowing before excluding anything else on a similar argument: the axis
is dated from the **client's** clock, which the spec has pinned since the first
generation run. `homePeriodRange` windows the series off `new Date()`,
`setFixedTime` makes that one instant, and the request therefore asks for the
same thirty days on every run. Home now holds three of the eight baselines.

The third of those, `home-empty-phone`, is photographed as a **second signed-in
user with nothing in it**. Home picks its onboarding panel over its portfolio on
`counts.holdings === 0`, so the state a new account is greeted with is
unreachable from the seeded session — and emptying that session to reach it
would delete what the other baselines are pictures of. `fixtures/visual-setup.ts`
writes both storage states; a screen names the one it wants with
`session: 'empty'`, and the spec groups the tests by session because
`storageState` is fixture configuration and cannot be chosen inside a test body.
The running-import variant of that panel is deliberately **not** covered: it is a
job in flight, and a screen that changes when the job lands is not something a
byte-exact baseline can hold still.

Three smaller determinism decisions, each of which came out of a run rather
than out of a guess:

- **The clock is pinned** (`page.clock.setFixedTime`). `/payments/recurring/new`
  defaults its "First due" field to today and wrote today's date into its first
  baseline.
- **The seed is base-currency-only.** A EUR holding has to be converted to be
  displayed, so its figure is a function of whatever FX rate the stack last
  fetched. `fixtures/visual-setup.ts` seeds USD for that reason, and it is a
  different portfolio — and a different session file — from the `shots` one.
- **The page is sealed off the public internet** (`fixtures/visual-network.ts`).
  See below; this one was not a decision until a baseline had already been
  flaking on it for weeks.

### Nothing off this machine — `fixtures/visual-network.ts`

Every request to a host that is not loopback is intercepted. The institution
mark is served from bytes in that file; anything else is aborted **and
recorded**, and a screen that recorded one fails naming every URL it reached.

The reason is worth keeping, because for as long as it lasted it looked like
noise. `getFaviconUrl` (`apps/frontend/app/src/lib/icons.ts`) points every
institution mark at `https://www.google.com/s2/favicons?domain=<host>&sz=64`,
fetched over the public internet *while the screenshot is being taken*. That
URL 301s to a **rotating** `t{0..3}.gstatic.com` shard — five consecutive runs
went t3, t1, t2, t3, t1 — so a mark has to complete DNS and TLS to one host, a
redirect, DNS and TLS to another, and the image, all inside the settle window.

Six runs of an unchanged tree gave **one fail and five passes**. Forcing the two
failure states deliberately, with `page.route` on the external URL only, says
which one it was:

| forced state | pixels different |
|---|---|
| fetch aborted → `FaviconImg` letter tile | 537, 537 |
| fetch delayed past the capture | 591 |
| **natural failing run, no probe** | **591** |

So the mark's track photographed **empty**, not as a letter tile — and those two
are distinguishable, which matters because "the icon broke" covers both and they
have different fixes.

**`toHaveScreenshot`'s retry manufactures confidence here rather than removing
it.** It retries until two captures agree, and two consecutive captures of a
mark that has not arrived agree perfectly. It logged `captured a stable
screenshot` over the empty track and then reported a pixel count. That is
SC-473's spinner exactly: a stable wrong answer reading identically to a stable
right one.

**`--update` was the wrong answer**, and it is the reflex a red run produces. It
cannot remove the difference; it records whichever side of the coin that run
landed on. A stale baseline fails consistently and gets fixed. A flaky one fails
sometimes, gets re-run past, and takes the gate's credibility with it.

**Raising the pixel threshold was the other wrong answer.** The tolerance would
have to cover a mark that is absent, and a tolerance that wide is blind on every
screen to buy determinism on one.

Three things the seal deliberately does:

- **It covers the whole off-host surface, not that one URL.** A gate that pins
  the one external asset it currently knows about is non-deterministic again the
  day somebody adds a second, silently. An unpinned off-host request is now a red
  run that names it — all of them, not the first, because a page that reaches two
  hosts and gets fixed for one is the same defect with a smaller number.
- **It matches on the hostname, not on the word `favicon`.** A pattern like
  `/favicon/i` also matches the app's own module URL under the dev server,
  `http://localhost:<port>/@fs/…/components/FaviconImg.tsx`, so a route keyed on
  the word intercepts the component instead of its image and the shell never
  mounts. Measured while building this.
- **It checks the substitution worked.** A screen declaring `institutionMark` in
  `visual/screens.ts` must show a decoded `<img>` at the pinned URL. That looks
  redundant beside a passing screenshot, and it is exactly what an interception
  fulfilling with an empty body, a 404 or a zero-byte PNG would slip past:
  `FaviconImg` catches the `onerror`, swaps in its letter tile, every screen still
  renders and the gate goes green having deleted the thing it was asked to hold
  still. **537 is what that looks like** — a passing-shaped fix that tests less
  than before.

The pinned mark is a flat magenta square rather than a copy of a real favicon.
A baseline could never assert what a bank's logo looks like — those pixels were
never ours — so what it holds is that a decoded image of the right size occupies
the row's leading track, and the colour is chosen so a reviewer cannot mistake
it for product design.

**This does not change what the app does for a real user.** The SPA still fetches
those icons from Google on every row, which is SC-208's subject — filed, and
still open in fact if not in status.

One thing this endpoint does that is *not* the cause here, recorded because it
is true and misleading: it is not byte-stable either. Ten requests for
`?domain=chase.com&sz=64` over ten seconds returned a 1568-byte JPEG seven times
and a 625-byte palettised PNG three times, and a browser-shaped `Accept` header
changes nothing. At 20 CSS pixels those two renderings differ in 293 of 400
pixels. But the seeded institution is `www.jpmorganchase.com`, whose bytes did
not move across thirty observations — so that is a real hazard of the dependency
and not what turned these baselines red.

### Tall viewports rather than `fullPage`

The v3 shell is a `100vh` column whose `<main>` is the scroller, so the document
never overflows and Playwright's `fullPage` option captures exactly the viewport
and nothing more. Growing the viewport is the only way to photograph what is
below the fold. It also has the better diff: a fixed-size image compares pixel
for pixel, where a content-sized one fails as an unreadable size mismatch the
first time a row is added.

### Baselines are migrations

One branch at a time, reviewed as the image diff in that branch's PR.
`--update` is the answer to a red run only **after** somebody has looked at what
went red. Regenerating the set to make a build green deletes the only record of
what changed — and since nothing else in this repo looks at these screens, that
record is the entire product of the gate.

`apps/frontend/app/tests/v3/visual-baselines.test.ts` holds the part that needs
no Docker, and it runs in `bun run test`: a screen with no baseline, a baseline
with no screen, and a baseline rendered at the wrong viewport width all fail
there. That is the same tie `a11y-coverage.test.ts` keeps between the
accessibility gate and `fixtures/v3-routes.ts`.

### Do not write to the app's sources while the gate runs (SC-499)

**A `bun lint:fix`, a `git checkout`, a rebase or an editor save under
`apps/frontend/app` or `packages/frontend/ui` reloads every screen mid-capture**,
and until this was found nothing said so.

The gate renders against the `frontend` container, which is `vite` in dev mode
with the repo bind-mounted. Vite's dev server broadcasts a `full-reload` to
every open page when a file in the app's module graph changes on disk, and
Vite's client answers it by calling `location.reload()` **with no console
output at all**. What comes back is the eagerly-loaded shell and a centred
spinner, `toHaveScreenshot` retries, gets the same spinner twice, logs
"captured a stable screenshot" and reports a pixel count.

That is the dangerous half: a stable wrong answer reads exactly like a stable
right one. On `--update` it writes the spinner into the baseline and every run
afterwards agrees with it — green, forever, on a screen nobody has ever seen.
It already happened once, to `home-phone` (SC-473).

Reproduced on demand: appending one comment line to `apps/frontend/app/src/main.tsx`
every three seconds during a run took `kitchen-sink-desktop` through **ten**
document loads and produced exactly that — a photograph of a spinner, reported
as "2260538 pixels (ratio 0.33) are different".

Two things the ticket suspected and neither is it. The **service worker** cannot
be: `main.tsx` registers it under `import.meta.env.PROD`, so a dev-server run
never installs one — and the reload it would trigger is guarded by
`wasDocumentControlledAtLoad()` (SC-130). Nor is it Vite's **dependency
optimiser**: wiping `node_modules/.vite` in the container and restarting the dev
server still gave 8/8 with exactly one document load per screen and no
re-optimisation in the server log.

`v3-screens.spec.ts` now counts document loads and fails, naming this, when a
screen was photographed across more than one — on a passing capture as well as a
failing one, because the passing case is the one that lies.

### Widening it

The cheapest place is `/kitchen-sink`. It renders every `@scani/ui` primitive
against the v3 tokens in both themes at once with no network data behind any of
it, and both of its baselines are already in the set — so a specimen added to
the gallery is covered by the next `--update` for free, on a screen that cannot
drift.
