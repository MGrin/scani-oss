# 2026-05-09 — `NODE_ENV=development` on prod machines outage

## Summary

| Field | Value |
|---|---|
| Date | 2026-05-09 |
| Duration | ~5 hours (15:44 UTC → 20:30 UTC; partial recovery from 18:24 onwards) |
| Services affected | `scani-data-provider`, `scani-backend`, `scani-worker` (all three Fly apps) |
| Customer-visible impact | All API calls to `api.scani.xyz` and tRPC against `scani-data-provider` returned 502/503 / connection timeouts. Worker stopped processing jobs. |
| Root cause (proximal) | `assertEnvIsolatedUrl` threw at boot, `process.exit(1)` triggered Fly's max-restart-count crash-loop, machines stopped indefinitely. |
| Root cause (distal) | `process.env.NODE_ENV` read as `'development'` on running Fly machines despite `fly.toml [env] NODE_ENV = "production"`. **Why** is still under investigation (see open questions below). |
| Triggering change | PR #440 added `assertEnvIsolatedUrl({ REDIS_URL })` + `({ DATABASE_URL })` calls to all three apps' `loadEnv()`. With NODE_ENV=development read at boot and a real Upstash REDIS_URL, the guard threw `REDIS_URL appears to be a remote URL but NODE_ENV=development. Refusing to boot — point at a local instance or set NODE_ENV=production`. |

## Timeline (UTC)

| Time | Event |
|---|---|
| 15:33 | PR #440 (round-2 P1+P2 follow-ups) merged. Deploy fires. |
| 15:44 | First failed deploy of `scani-data-provider`: rolling deploy times out on 2/2 health checks. |
| 16:18 | PR #441 (round-3) merged — bumps `grace_period 30s → 60s`, `memory 512MB → 1024MB`. |
| 16:26 | PR #442 (revert `sentry-alerts.tf`) merged. |
| 17:11 | PR #443 (deferred boot + `/ready` endpoint) merged. |
| 17:57 | PR #444 (drop `:6379` from env-isolation regex) merged. |
| 18:22 | PR #445 (revert data-provider boot path to PR #438) merged. **First partial recovery.** |
| 19:11 | PR #446 (Fly diagnostics workflow) merged. |
| 19:17 | PR #447 (stage `NODE_ENV=production` as Fly secret) merged. |
| 19:21 | PR #448 (re-introduce data-provider improvements) merged. |
| 19:34 | Fly diagnostics run reveals: ALL three apps boot with `process.env.NODE_ENV='development'`, despite secret-stage. |
| 20:00 | PR #449 (emergency: remove `assertEnvIsolatedUrl` call sites entirely) merged. **Full recovery.** |

## Root cause

The code-side root cause is clear: `loadEnv()` called `assertEnvIsolatedUrl`, which threw because `NODE_ENV` read as `development` while the URL was the real Upstash production URL. The throw exited the process, Fly's max-restart-count gave up after 10 attempts, all machines ended up `stopped`.

The deeper question — **why was `process.env.NODE_ENV` reading `development`** — remains open. Strong evidence:

- All three apps' Dockerfiles set `ENV NODE_ENV=production` in the runtime stage:
  - `apps/backend/data-provider/Dockerfile:40`
  - `apps/backend/api/Dockerfile:41`
  - `apps/backend/worker/Dockerfile:38`
- `fly.toml [env] NODE_ENV = "production"` was set in PR #418 on **2026-05-01**.
- The machines that crashed were created on **2026-05-05** (after the `[env]` block was in fly.toml).
- PR #447 staged `NODE_ENV=production` as a Fly secret, deployed, and the machines STILL booted with `NODE_ENV=development`.

Open hypotheses (none confirmed):

1. A pre-existing Fly secret `NODE_ENV=development` on the apps from an earlier era that was never explicitly unset. `flyctl secrets list -a <app>` would reveal it. Even after PR #447's `--stage` push, an existing secret would have been preserved with the new value, but maybe the staging flag means the value isn't applied until the next manual `flyctl deploy` and the path-filter machinery skipped that.
2. Bun's runtime might read `NODE_ENV` from the `--env-file` flag or a wrapper script that sets `development` before the actual binary starts.
3. The `/app/server` binary (the build artifact) might have `NODE_ENV=development` baked in via the build step's env at compile time.
4. Fly's per-machine env config is independent of `[env]` and may have been set to `development` at machine creation if the original deploy didn't include the `[env]` block.

## What worked

- **Fly diagnostics workflow (PR #446)** — once we had `flyctl logs --since 30m` output via a CI workflow, the actual error message became visible within 1 min. Without that, we were guessing for hours from the outside.
- **Smoke-test bound (PR #444's `--max-time 10`)** — cut each failed-deploy CI cost from 17min to 75s.
- **Final emergency fix (PR #449)** — removing the call sites was unambiguous and unblocked production immediately.

## What didn't work

- **Iterating fixes blindly without diagnostics**. PRs #441, #443, #444 all attempted to fix the symptoms (slow boot, /ready timing, regex precision) when the actual problem was in a completely different layer (env propagation). Each iteration burned ~15 min of CI minutes and 30+ min of investigation.
- **Defensive guards that crash the boot path**. `assertEnvIsolatedUrl` was the canonical example. The guard's heuristic was correct in the abstract, but its failure mode (`throw + process.exit(1)`) turned a misconfigured env var into a hard-down.
- **`flyctl deploy` ↔ Fly secrets ↔ `[env]` precedence is not well-documented internally**. Several false hypotheses (regex too greedy, port pattern too aggressive) sent us the wrong direction.

## Action items

- ✅ **A1**. Refactor `assertEnvIsolatedUrl` to a non-throwing `checkEnvIsolatedUrl` returning `{ ok, reason? }`. Call sites warn + log + Sentry, never `process.exit(1)`. (Round-4 PR A, this PR.)
- ✅ **A2**. `probeDataProvider()` exits replaced with warn-and-continue on api + worker. (Round-4 PR A, this PR.)
- ✅ **A3**. Data-provider deferred-boot IIFE retries 10× with exponential backoff before exiting. (Round-4 PR A, this PR.)
- 🟡 **A4**. Step-level `timeout-minutes: 5` on every smoke-test step in `deploy-fly.yaml`. (Round-4 PR B.)
- 🟡 **A5**. Last-known-good production tag + one-button `rollback.yaml` workflow. (Round-4 PR B.)
- 🟡 **A6**. Confirm-and-document the actual NODE_ENV root cause. Run `flyctl secrets list -a <app>` and `flyctl machine show <id>` from a terminal to inspect the env stack. Update this doc when known.
- 🔲 **A7**. Add a pre-deploy "dry boot" CI step that runs the actual built image with prod-like env vars and asserts the process binds to its port within N seconds. Catches NODE_ENV-style traps before they reach production.

## What would have caught this earlier?

- **A "dry boot" CI step** that runs the built image with `--env NODE_ENV=production --env REDIS_URL=rediss://prod-shaped` and asserts `/health` responds. Would have caught the assertEnvIsolatedUrl + NODE_ENV interaction in PR #440's CI.
- **Defensive guards as warnings, not throws**. Same change as A1.
- **Fly diagnostics workflow available before the incident**. Built reactively in PR #446; should have existed prophylactically.

## Lessons for future code review

When reviewing a PR that adds a guard / defensive check at boot:

- Does the guard fail gracefully (return false / warn / mark unhealthy), or does it kill the process?
- If it kills the process, is its detection logic 100% reliable across all expected env shapes (incl. transient propagation lag, secret-vs-env precedence, etc.)?
- Would the guard's failure mode be debuggable from outside (i.e. without `flyctl logs` access)?

The default answer should be: **boot succeeds, guard surfaces the issue via /readyz or Sentry**. `process.exit(1)` is a last resort, reserved for "the process truly cannot do its job at all" situations (e.g. corrupted binary, missing critical secret).
