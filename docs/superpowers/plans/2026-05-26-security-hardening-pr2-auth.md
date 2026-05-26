# Security Hardening — PR 2 (Auth Hardening) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close six concrete auth-surface weaknesses identified in the 2026-05-25 security audit: plaintext magic-link/OTP tokens in the database (M1), `SameSite=Lax` on the session cookie (M4), unlimited `sessions.revoke` calls per user (M3), missing rate limit on email-change / password-change endpoints (L4), missing session-freshness requirement on email change (L5), and any remaining account-enumeration oracle that survived PR1's H1 fix (M2).

**Architecture:** Six small, independent fixes that share the same review surface — `apps/backend/api/src/auth/better-auth.ts` (M1, M4, L5), `apps/backend/api/src/index.ts` (L4, M2-conditional), `apps/backend/api/src/presentation/routers/sessions.ts` (M3), and one new helper on `packages/infra/rate-limiter` (M3). The total LOC is ~80 across 5 files. Each task is independently reviewable.

**Tech Stack:** Bun + tsgo + Biome. Better-Auth 1.6.5 with `magicLink` + `emailOTP` plugins. The `magicLink` plugin defaults to `storeToken: "plain"` (verified in `node_modules/better-auth/dist/plugins/magic-link/index.mjs:26`) and `emailOTP` defaults likewise — that's the root of M1. Better-Auth's built-in `/api/auth/change-email` and `/api/auth/change-password` endpoints respect a session-config `freshAge` (verified in `node_modules/better-auth/dist/api/routes/update-user.mjs:304-307`). `packages/infra/rate-limiter` exposes `InflowRateLimiter.tryConsume(req)` keyed off `Request` headers; we add a sibling `tryConsumeKey(identity)` overload for the per-user case where we already have `ctx.userId` without a `Request`.

**Why this is one PR and not six:** All six are sub-50-LOC config or one-helper changes against the same auth surface. Reviewers benefit from seeing them together (each change interacts subtly with the others — e.g., M4's `SameSite=Strict` and L5's `freshAge` both affect the magic-link click-from-email flow that must still work). One PR, one CI run, one rollback boundary.

**Branch strategy assumption:** PR #48 (PR1 of this audit series) is already merged to `main` at the time this plan runs. If #48 hasn't merged yet, see "Branch strategy" at the end of the plan for stacked-PR instructions.

**Out of scope** (tracked separately):
- H4 encryption consolidation (`@scani/shared/utils/encryption.ts` → `@scani/security`) — own plan (PR 3).
- L2 CSP `report-to` endpoint, M7 SVG audit — own plan (PR 4).
- L6 passkeys — deferred per user direction.
- Data-provider's equivalent password-endpoint disable (gated behind `CLOUD_MANAGEMENT_ENABLED`, off in OSS) — separate ticket.

---

## File Structure

| Path | Change | Responsibility |
|------|--------|----------------|
| `apps/backend/api/src/auth/better-auth.ts` | Modify (3 locations) | (M1) add `storeToken: "hashed"` to `magicLink({...})`, `storeOTP: "hashed"` to `emailOTP({...})`. (M4) change `sameSite: 'lax'` → `'strict'`. (L5) add `freshAge: 60 * 5` to the `session: {...}` block so `change-email` / `change-password` require a session ≤5 minutes old. |
| `apps/backend/api/src/index.ts` | Modify (1 location) | (L4) extend the `isAuthAttempt` predicate in the `/api/auth/*` gate to include `/api/auth/change-email` and `/api/auth/change-password`. (M2) only modify here if the verification in Task 6 finds a remaining oracle. |
| `apps/backend/api/src/presentation/routers/sessions.ts` | Modify (revoke + revokeOthers) | (M3) apply per-user rate limit (10/min) to both `revoke` and `revokeOthers`. |
| `packages/infra/rate-limiter/src/inflow/inflow-rate-limiter.ts` | Modify | (M3) expose `tryConsumeKey(identity: string, tokens?: number)` on the abstract base — calls the same underlying `incrementCounter` as `tryConsume` but skips the `keyFn` since the caller already has the identity. |
| `packages/infra/rate-limiter/src/index.ts` | Modify | (M3) add `createSessionRevokeLimiter(redis, perMinute=10)` factory matching the existing `createSignupLimiter` / `createStandardLimiter` style. |
| `packages/infra/rate-limiter/tests/inflow/per-user.test.ts` | Create | (M3) test the new `tryConsumeKey` method: bucket counts, expiry, retry-after timing. |
| `apps/backend/api/tests/auth/better-auth-config.test.ts` | Create | (M1, M4, L5) introspect the constructed Better-Auth instance to verify `magicLink.storeToken === "hashed"`, `emailOTP.storeOTP === "hashed"`, `defaultCookieAttributes.sameSite === "strict"`, `session.freshAge === 300`. |

No DB migrations. No env vars added. No frontend changes.

---

## Task 1: Hash magic-link and OTP tokens in the DB (M1)

**Files:**
- Modify: `apps/backend/api/src/auth/better-auth.ts:210-246` (magicLink + emailOTP plugin config)
- Create: `apps/backend/api/tests/auth/better-auth-config.test.ts`

**Context:** Better-Auth's `magicLink` plugin defaults `storeToken: "plain"` (`node_modules/better-auth/dist/plugins/magic-link/index.mjs:26`) and `emailOTP` defaults `storeOTP: "plain"`. Tokens land in `user_verifications.value` unhashed. A read-only database leak gives the attacker valid auth tokens for 15 minutes (magic-link) / 5 minutes (OTP). The fix is two config flags; the plugin then SHA-256 hashes tokens before storing them and re-hashes on verification.

- [ ] **Step 1: Write the failing test**

Create `apps/backend/api/tests/auth/better-auth-config.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createBetterAuth } from '../../src/auth/better-auth';

function build() {
  return createBetterAuth({
    baseURL: 'http://localhost:3001',
    secret: 'test-secret-at-least-32-characters-long',
    trustedOrigins: ['http://localhost:5173'],
    cookieDomain: undefined,
    screenshotBotSecret: 'test-screenshot-bot-secret',
  });
}

describe('Better-Auth config — auth hardening', () => {
  test('magicLink stores tokens hashed (M1)', () => {
    const auth = build();
    const opts = auth.options;
    const magicLinkPlugin = opts.plugins?.find((p) => p.id === 'magic-link');
    expect(magicLinkPlugin).toBeDefined();
    // Better-Auth plugins expose their resolved options on the instance.
    // The exact accessor depends on the plugin's internal shape — read
    // the plugin's source if this fails:
    // `node_modules/better-auth/dist/plugins/magic-link/index.mjs`.
    expect((magicLinkPlugin as { options?: { storeToken?: unknown } }).options?.storeToken).toBe(
      'hashed',
    );
  });

  test('emailOTP stores OTPs hashed (M1)', () => {
    const auth = build();
    const opts = auth.options;
    const emailOtpPlugin = opts.plugins?.find((p) => p.id === 'email-otp');
    expect(emailOtpPlugin).toBeDefined();
    expect((emailOtpPlugin as { options?: { storeOTP?: unknown } }).options?.storeOTP).toBe(
      'hashed',
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test --preload ./packages/business/domain/test-preload.ts apps/backend/api/tests/auth/better-auth-config.test.ts
```

Expected: 2 fails — `storeToken` is `"plain"` or undefined, `storeOTP` likewise. If the test fails because the plugin shape doesn't match what I assumed (no `.options` accessor), STOP and report — we need a different introspection strategy.

- [ ] **Step 3: Add the config flags**

Open `apps/backend/api/src/auth/better-auth.ts`. Find the `magicLink({...})` block (around line 210):

```ts
      magicLink({
        sendMagicLink: async ({ email: to, url }) => { ... },
        expiresIn: 60 * 15, // 15 min
      }),
```

Add `storeToken: 'hashed',` immediately after the `expiresIn` line:

```ts
      magicLink({
        sendMagicLink: async ({ email: to, url }) => { ... },
        expiresIn: 60 * 15, // 15 min
        // Hash tokens before storing in user_verifications.value. A read-
        // only DB leak otherwise hands the attacker valid magic-links for
        // the next 15 minutes. Better-Auth re-hashes on verification.
        storeToken: 'hashed',
      }),
```

Find the `emailOTP({...})` block immediately below (around line 230):

```ts
      emailOTP({
        otpLength: 6,
        expiresIn: 5 * 60, // 5 min
        allowedAttempts: 5,
        sendVerificationOTP: async ({ email: to, otp, type }) => { ... },
      }),
```

Add `storeOTP: 'hashed',` after `allowedAttempts`:

```ts
      emailOTP({
        otpLength: 6,
        expiresIn: 5 * 60, // 5 min
        allowedAttempts: 5,
        // Hash OTPs before storing in user_verifications.value (same
        // reasoning as magicLink.storeToken above). The user-facing OTP
        // is still emailed in plaintext; only the DB stores the hash.
        storeOTP: 'hashed',
        sendVerificationOTP: async ({ email: to, otp, type }) => { ... },
      }),
```

- [ ] **Step 4: Run the test to verify it passes**

```
bun test --preload ./packages/business/domain/test-preload.ts apps/backend/api/tests/auth/better-auth-config.test.ts
```

Expected: 2 pass.

- [ ] **Step 5: Run the broader auth-related test suite**

```
bun test --preload ./packages/business/domain/test-preload.ts apps/backend/api/ packages/business/domain/ --timeout 30000
```

Expected: pass. Magic-link / OTP flows that hit the DB will still work because Better-Auth applies the same hash on the verification side.

- [ ] **Step 6: Type-check + lint**

```
bun run type-check
bun lint:fix
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/backend/api/src/auth/better-auth.ts apps/backend/api/tests/auth/better-auth-config.test.ts
git commit -m "fix(api): hash magic-link tokens and OTPs in DB (M1)"
```

---

## Task 2: SameSite=Strict on the session cookie (M4)

**Files:**
- Modify: `apps/backend/api/src/auth/better-auth.ts:201-207` (the `defaultCookieAttributes` block)
- Modify: `apps/backend/api/tests/auth/better-auth-config.test.ts` (add one test)

**Context:** Current config:
```ts
defaultCookieAttributes: opts.cookieDomain
  ? {
      domain: opts.cookieDomain,
      sameSite: 'lax',
      secure: opts.baseURL.startsWith('https://'),
    }
  : undefined,
```
`Lax` permits top-level GET navigations to carry the session cookie cross-site (an attacker page can `<a href="https://app.scani.xyz/sensitive">` and rely on the cookie being attached). `Strict` blocks that. The magic-link click-from-email flow is unaffected: the click is a fresh navigation establishing a new session via `Set-Cookie` in the response, not a request that needs an existing cookie.

- [ ] **Step 1: Extend the existing config test**

Open `apps/backend/api/tests/auth/better-auth-config.test.ts` (created in Task 1). Add inside the same `describe`:

```ts
  test('session cookie is SameSite=Strict in deployed mode (M4)', () => {
    const auth = createBetterAuth({
      baseURL: 'https://app.scani.example',
      secret: 'test-secret-at-least-32-characters-long',
      trustedOrigins: ['https://app.scani.example'],
      cookieDomain: 'app.scani.example',
      screenshotBotSecret: 'test-screenshot-bot-secret',
    });
    const attrs = auth.options.advanced?.defaultCookieAttributes;
    expect(attrs?.sameSite).toBe('strict');
    expect(attrs?.secure).toBe(true);
    expect(attrs?.domain).toBe('app.scani.example');
  });
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test --preload ./packages/business/domain/test-preload.ts apps/backend/api/tests/auth/better-auth-config.test.ts
```

Expected: 1 new fail — `sameSite` is `'lax'`.

- [ ] **Step 3: Change the config**

In `apps/backend/api/src/auth/better-auth.ts:201-207`, replace `sameSite: 'lax',` with `sameSite: 'strict',`. The block becomes:

```ts
      defaultCookieAttributes: opts.cookieDomain
        ? {
            domain: opts.cookieDomain,
            // SameSite=Strict on the session cookie. Lax would allow top-
            // level GET navigations to carry the cookie cross-site (so an
            // attacker page's <a href="https://app.scani/sensitive">
            // attaches the session). The magic-link click-from-email flow
            // is unaffected: it establishes a NEW session via Set-Cookie
            // in the response and doesn't rely on an existing cookie.
            sameSite: 'strict',
            secure: opts.baseURL.startsWith('https://'),
          }
        : undefined,
```

- [ ] **Step 4: Verify the test passes**

```
bun test --preload ./packages/business/domain/test-preload.ts apps/backend/api/tests/auth/better-auth-config.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Type-check + lint**

```
bun run type-check
bun lint:fix
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/backend/api/src/auth/better-auth.ts apps/backend/api/tests/auth/better-auth-config.test.ts
git commit -m "fix(api): tighten session cookie to SameSite=Strict (M4)"
```

---

## Task 3: Per-user rate limit on `sessions.revoke` (M3)

**Files:**
- Modify: `packages/infra/rate-limiter/src/inflow/inflow-rate-limiter.ts` (add `tryConsumeKey` method)
- Modify: `packages/infra/rate-limiter/src/index.ts` (add `createSessionRevokeLimiter` factory)
- Create: `packages/infra/rate-limiter/tests/inflow/per-user.test.ts`
- Modify: `apps/backend/api/src/presentation/routers/sessions.ts` (apply limiter to `revoke` + `revokeOthers`)

**Context:** `sessions.ts:41-68` (`revoke`) and the analogous `revokeOthers` accept a token and revoke a session owned by the caller. The route correctly verifies ownership but has no per-user rate limit. An attacker with a stolen session token can loop-revoke the victim's other devices indefinitely (limited only by the global 300/min IP throttle, which the attacker can rotate). Add a 10/min per-user budget — well above any legitimate revoke pattern (UI shows a list, user clicks one at a time).

The existing `InflowRateLimiter.tryConsume(req)` derives identity from request headers (IP via XFF). For per-user limiting we already have `ctx.userId` in the tRPC handler — no need to round-trip through a fabricated `Request`. Add a sibling `tryConsumeKey(identity, tokens?)` method that uses the supplied identity directly.

- [ ] **Step 1: Write the failing test for `tryConsumeKey`**

Create `packages/infra/rate-limiter/tests/inflow/per-user.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { InMemoryInflowRateLimiter } from '../../src/inflow/in-memory';

describe('InflowRateLimiter.tryConsumeKey', () => {
  test('allows up to max within the window, then blocks', async () => {
    const limiter = new InMemoryInflowRateLimiter({
      windowMs: 60_000,
      max: 3,
      namespace: 'rl:test',
    });
    expect(await limiter.tryConsumeKey('user:a')).toEqual({ ok: true });
    expect(await limiter.tryConsumeKey('user:a')).toEqual({ ok: true });
    expect(await limiter.tryConsumeKey('user:a')).toEqual({ ok: true });
    const fourth = await limiter.tryConsumeKey('user:a');
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) {
      expect(fourth.retryAfterSec).toBeGreaterThan(0);
      expect(fourth.retryAfterSec).toBeLessThanOrEqual(60);
    }
  });

  test('separate identities have separate buckets', async () => {
    const limiter = new InMemoryInflowRateLimiter({
      windowMs: 60_000,
      max: 1,
      namespace: 'rl:test',
    });
    expect(await limiter.tryConsumeKey('user:a')).toEqual({ ok: true });
    expect(await limiter.tryConsumeKey('user:b')).toEqual({ ok: true });
    expect((await limiter.tryConsumeKey('user:a')).ok).toBe(false);
    expect((await limiter.tryConsumeKey('user:b')).ok).toBe(false);
  });

  test('multi-token consume', async () => {
    const limiter = new InMemoryInflowRateLimiter({
      windowMs: 60_000,
      max: 5,
      namespace: 'rl:test',
    });
    expect(await limiter.tryConsumeKey('user:a', 3)).toEqual({ ok: true });
    expect(await limiter.tryConsumeKey('user:a', 3)).toMatchObject({ ok: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```
bun test --preload ./packages/business/domain/test-preload.ts packages/infra/rate-limiter/tests/inflow/per-user.test.ts
```

Expected: 3 fails — `tryConsumeKey` is not a function.

- [ ] **Step 3: Add `tryConsumeKey` to the abstract base**

Open `packages/infra/rate-limiter/src/inflow/inflow-rate-limiter.ts`. Inside the `InflowRateLimiter` class, immediately after the existing `tryConsume` method (around line 77), add:

```ts
  /**
   * Same as `tryConsume` but the caller supplies the identity directly
   * instead of having it derived from a `Request`. Use this when the
   * route handler already knows the identity it wants to rate-limit on
   * (e.g. `ctx.userId` inside a tRPC mutation) and constructing a
   * fabricated `Request` just to satisfy the header-based `keyFn`
   * would be ceremony for nothing.
   */
  async tryConsumeKey(
    identity: string,
    tokens = 1,
  ): Promise<{ ok: true } | { ok: false; retryAfterSec: number }> {
    const nowSec = Math.floor(Date.now() / 1000);
    const windowStart = Math.floor(nowSec / this.windowSec) * this.windowSec;
    const count = await this.incrementCounter(identity, windowStart, tokens);
    if (count <= this.max) return { ok: true };
    return { ok: false, retryAfterSec: Math.max(1, windowStart + this.windowSec - nowSec) };
  }
```

- [ ] **Step 4: Verify the test passes**

```
bun test --preload ./packages/business/domain/test-preload.ts packages/infra/rate-limiter/tests/inflow/per-user.test.ts
```

Expected: 3 pass.

- [ ] **Step 5: Add the session-revoke limiter factory**

Open `packages/infra/rate-limiter/src/index.ts`. After `createSignupLimiter` (around line 92), add:

```ts
// Per-user limiter for session-revocation actions. The route correctly
// scopes revocation by ownership (an attacker with one stolen session
// can't revoke another user's sessions), but with no per-user budget a
// compromised session can loop-revoke the victim's OTHER devices to
// lock them out. 10/min is well above any legitimate revoke pattern
// (the UI lists sessions and a user clicks one at a time).
export const createSessionRevokeLimiter = (redis: Redis | null, perMinute = 10): InflowRateLimiter =>
  createInflowLimiter(redis, {
    windowMs: 60_000,
    max: perMinute,
    namespace: 'rl:session-revoke',
  });
```

- [ ] **Step 6: Wire the limiter into `apps/backend/api/src/index.ts`**

Open `apps/backend/api/src/index.ts`. Find the import line for `createSignupLimiter` (around line 49):

```ts
import {
  ...,
  createSignupLimiter,
  ...
} from '@scani/rate-limiter';
```

Add `createSessionRevokeLimiter` to the import list (Biome will sort alphabetically).

Find the line where `signupLimiter` is instantiated (around line 240):

```ts
const signupLimiter = createSignupLimiter(redisConnection, 6);
```

Add immediately below:

```ts
const sessionRevokeLimiter = createSessionRevokeLimiter(redisConnection, 10);
```

Now thread it into the tRPC context so the router can reach it. Find the `buildCreateContext` call (around line 435 — search for `buildCreateContext`). The context builder takes a config object; add `sessionRevokeLimiter` to whatever object is passed. If you can't see how to thread it, STOP and report — the context shape is the deciding factor.

- [ ] **Step 7: Update the tRPC context type**

Find `apps/backend/api/src/presentation/trpc.ts` (or wherever the context type is declared — search for `buildCreateContext` and `createContext`). Add `sessionRevokeLimiter: InflowRateLimiter` to the context object the builder returns. Type-import `InflowRateLimiter` from `@scani/rate-limiter`.

- [ ] **Step 8: Apply the limiter in `sessions.revoke`**

Open `apps/backend/api/src/presentation/routers/sessions.ts`. Find the `revoke` mutation (around line 41). After the `ctx.userId` check and before `getBetterAuth()`, add:

```ts
      const rl = await ctx.sessionRevokeLimiter.tryConsumeKey(`user:${ctx.userId}`);
      if (!rl.ok) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Too many session-revoke attempts; retry in ${rl.retryAfterSec}s`,
        });
      }
```

Apply the same block at the top of `revokeOthers` (immediately after the `ctx.headers` / `ctx.userId` guards). `revokeOthers` is one request that revokes many sessions, so 1 token per call is correct — same budget.

- [ ] **Step 9: Run the test suite**

```
bun test --preload ./packages/business/domain/test-preload.ts packages/ apps/backend/api/ --timeout 30000
```

Expected: pass. If the sessions tests fail because they don't provide `sessionRevokeLimiter` in the mocked ctx, update those test factories to inject an `InMemoryInflowRateLimiter` with a generous budget (e.g. `max: 1000`).

- [ ] **Step 10: Type-check + lint**

```
bun run type-check
bun lint:fix
```

Expected: clean.

- [ ] **Step 11: Commit**

```bash
git add packages/infra/rate-limiter/src/inflow/inflow-rate-limiter.ts packages/infra/rate-limiter/src/index.ts packages/infra/rate-limiter/tests/inflow/per-user.test.ts apps/backend/api/src/presentation/routers/sessions.ts apps/backend/api/src/index.ts apps/backend/api/src/presentation/trpc.ts
git commit -m "fix(api): per-user rate limit on sessions.revoke + revokeOthers (M3)"
```

---

## Task 4: Extend signup limiter to change-email + change-password (L4)

**Files:**
- Modify: `apps/backend/api/src/index.ts:440-457` (the `isAuthAttempt` predicate inside the `/api/auth/*` Elysia route)

**Context:** Better-Auth's built-in `POST /api/auth/change-email` and `POST /api/auth/change-password` endpoints accept a target email / new password. Without a per-IP rate limit they enable two abuse patterns: (a) repeatedly requesting confirmation emails to spam a victim's inbox, (b) brute-force on the change-password endpoint via the current-password challenge. The existing signup-limiter pattern already gates 4 auth paths with a 6/hour IP budget; adding these two extends the same defense.

Note: `change-password` is technically dead after PR #48's H1 fix (the password path is disabled), but the route may still be reachable depending on Better-Auth's plugin wiring. Adding it to the gate is defense-in-depth and costs nothing.

- [ ] **Step 1: Read the current predicate**

```
sed -n '440,460p' apps/backend/api/src/index.ts
```

Expected: the `isAuthAttempt` predicate enumerating four path prefixes (`/sign-up`, `/sign-in`, `/email-otp/send-verification-otp`, `/forget-password`).

- [ ] **Step 2: Extend the predicate**

In `apps/backend/api/src/index.ts`, find the `isAuthAttempt` const (around line 453). It currently reads:

```ts
    const isAuthAttempt =
      pathname.startsWith('/api/auth/sign-up') ||
      pathname.startsWith('/api/auth/sign-in') ||
      pathname.startsWith('/api/auth/email-otp/send-verification-otp') ||
      pathname.startsWith('/api/auth/forget-password');
```

Add two more disjuncts:

```ts
    const isAuthAttempt =
      pathname.startsWith('/api/auth/sign-up') ||
      pathname.startsWith('/api/auth/sign-in') ||
      pathname.startsWith('/api/auth/email-otp/send-verification-otp') ||
      pathname.startsWith('/api/auth/forget-password') ||
      // L4: change-email floods a victim's inbox with confirmation
      // links; change-password (dead post-H1 but reachable per
      // Better-Auth's route table) is a brute-force surface on the
      // current-password challenge.
      pathname.startsWith('/api/auth/change-email') ||
      pathname.startsWith('/api/auth/change-password');
```

- [ ] **Step 3: Type-check + lint**

```
bun run type-check
bun lint:fix
```

Expected: clean.

- [ ] **Step 4: Run the broader test suite**

```
bun test --preload ./packages/business/domain/test-preload.ts apps/backend/api/ --timeout 30000
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/api/src/index.ts
git commit -m "fix(api): apply signup limiter to change-email + change-password (L4)"
```

---

## Task 5: Require fresh session for sensitive ops (L5)

**Files:**
- Modify: `apps/backend/api/src/auth/better-auth.ts:185-194` (the `session: {...}` block)
- Modify: `apps/backend/api/tests/auth/better-auth-config.test.ts` (add one test)

**Context:** Better-Auth's `change-email` and `change-password` endpoints check the session's `freshAge` (`node_modules/better-auth/dist/api/routes/update-user.mjs:304-307`). If the session is older than `freshAge`, the endpoint rejects with `SESSION_EXPIRED` and the user must re-authenticate. Our current config doesn't set `freshAge`, so it falls to Better-Auth's default (24 hours). For account-recovery-grade operations like email change, 5 minutes is a more defensible window — the user just authenticated, then immediately did the sensitive action.

- [ ] **Step 1: Add the failing test**

Open `apps/backend/api/tests/auth/better-auth-config.test.ts`. Add inside the same `describe`:

```ts
  test('session has freshAge=300 so change-email requires a recent login (L5)', () => {
    const auth = build();
    expect(auth.options.session?.freshAge).toBe(60 * 5);
  });
```

Run it:

```
bun test --preload ./packages/business/domain/test-preload.ts apps/backend/api/tests/auth/better-auth-config.test.ts
```

Expected: 1 new fail — `freshAge` is undefined.

- [ ] **Step 2: Add `freshAge` to the session config**

Open `apps/backend/api/src/auth/better-auth.ts`. Find the `session: {...}` block (around line 185):

```ts
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // extend at most once per day
      // The cookie cache is per-instance and not shared across Fly machines.
      // ...
      cookieCache: isNodeEnvProduction() ? { enabled: false } : { enabled: true, maxAge: 5 * 60 },
    },
```

Add a `freshAge` line immediately after `updateAge`:

```ts
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // extend at most once per day
      // Sensitive ops (Better-Auth's /change-email, /change-password,
      // and any other endpoint that calls `requireFreshSession`) reject
      // when the session is older than freshAge. 5 minutes forces the
      // user to have authenticated very recently before changing
      // recovery-grade attributes — even an attacker with a long-lived
      // stolen cookie cannot pivot to email-change without re-auth.
      freshAge: 60 * 5, // 5 min
      cookieCache: isNodeEnvProduction() ? { enabled: false } : { enabled: true, maxAge: 5 * 60 },
    },
```

- [ ] **Step 3: Verify the test passes**

```
bun test --preload ./packages/business/domain/test-preload.ts apps/backend/api/tests/auth/better-auth-config.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Type-check + lint + broader test**

```
bun run type-check
bun lint:fix
bun test --preload ./packages/business/domain/test-preload.ts apps/backend/api/ --timeout 30000
```

Expected: clean / pass.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/api/src/auth/better-auth.ts apps/backend/api/tests/auth/better-auth-config.test.ts
git commit -m "fix(api): require fresh session (5min) for change-email/password (L5)"
```

---

## Task 6: Verify account enumeration is closed post-H1 (M2)

**Files:**
- Read-only investigation; conditional modification of `apps/backend/api/src/index.ts` if a gap is found.

**Context:** Pre-PR1, the audit identified account enumeration via Better-Auth's distinguishable signup/sign-in error codes ("email exists" vs "new email"). PR1's H1 disabled the password sign-up and sign-in endpoints, which were the documented oracle. This task verifies that no other endpoint still distinguishes "this email is registered" from "this email is not registered" in its response.

The enumeration surfaces left to check after H1:
1. `POST /api/auth/email-otp/send-verification-otp` — does it return different status / body when the email is registered vs unknown?
2. `POST /api/auth/sign-in/email-otp` (with bogus OTP) — does it return different error when no such email?
3. `POST /api/auth/sign-in/magic-link` — same question.
4. `POST /api/auth/email-otp/verify-email` and `/email-otp/reset-password` — similar.

If any of these distinguishes by status / message / timing, we either normalize the response in our Elysia wrapper at `apps/backend/api/src/index.ts:440+` (before `betterAuthInstance.handler(cloned)`) or accept it as a documented residual risk.

- [ ] **Step 1: Read each endpoint's source to map the response shape**

For each path, read the source:

```
grep -l "send-verification-otp\|sign-in/email-otp\|sign-in/magic-link" node_modules/better-auth/dist/api/routes/*.mjs node_modules/better-auth/dist/plugins/email-otp/*.mjs node_modules/better-auth/dist/plugins/magic-link/*.mjs
```

For each match, read the file and note: does the response branch on `user === null` or similar? What's the response body / status in each branch?

- [ ] **Step 2: Document findings in a short comment block**

Create a temporary scratch file at `/tmp/m2-findings.md` (not committed) with one section per endpoint:

```
### /api/auth/email-otp/send-verification-otp
Returns 200 + { } regardless of email registration? [Y/N]
Source ref: <file:line>

### /api/auth/sign-in/email-otp
Returns "INVALID_OTP" regardless of email? [Y/N]
Source ref: <file:line>

(etc.)
```

- [ ] **Step 3: Decide and either close or fix**

Two outcomes:

**(a) All endpoints already return uniform responses:** Mark M2 as closed. Add a one-paragraph comment to `apps/backend/api/src/auth/better-auth.ts` near the magicLink/emailOTP plugin config documenting which endpoints were audited and confirmed safe, with the audit date. Commit with message `docs(api): document M2 verification — no enumeration oracle after H1 fix`.

**(b) An endpoint still enumerates:** Add a response-normalization wrapper at `apps/backend/api/src/index.ts` inside the `/api/auth/*` route, AFTER calling `betterAuthInstance.handler(cloned)`. The wrapper rewrites the offending error code to a generic one for the enumerating endpoint specifically — not blanket normalization (which would mask real errors).

Sample wrapper if needed:

```ts
const response = await betterAuthInstance.handler(cloned);
const pathname = new URL(request.url).pathname;
// Specific endpoint normalization here; do NOT blanket-normalize.
if (pathname === '/api/auth/<offending-path>' && response.status === 4xx) {
  const body = await response.json();
  if (body.code === '<enumerating-code>') {
    return new Response(JSON.stringify({ message: 'Check your email', code: 'OK' }), {
      status: 200,
      headers: response.headers,
    });
  }
}
return response;
```

This branch is conditional — only write it if Step 1's investigation finds an actual oracle.

- [ ] **Step 4: Commit (either branch)**

If (a): single docs commit.
If (b):

```bash
git add apps/backend/api/src/index.ts
git commit -m "fix(api): normalize <endpoint> response to close enumeration oracle (M2)"
```

---

## Task 7: Pre-push verification + open PR

- [ ] **Step 1: Run full type-check**

```
bun run type-check
```

Expected: clean across all workspaces.

- [ ] **Step 2: Run the linter**

```
bun lint:fix
```

Expected: clean.

- [ ] **Step 3: Run the full test suite**

```
bun test --preload ./packages/business/domain/test-preload.ts packages/ apps/backend/api/ --timeout 30000
```

Expected: pass (including the new tests added in Tasks 1, 2, 3, 5).

- [ ] **Step 4: Manual end-to-end smoke test via the dev stack**

Start the stack:

```
bun dev:stack
```

Wait ~30 seconds for `docker compose ps` to show all services healthy. Then:

1. **M1 + M4 + L5 — OTP sign-in still works:**
   - Open http://localhost:5173/auth → enter `manual-test@example.com` → submit
   - Open http://localhost:8026 (Mailpit) → confirm OTP email arrived
   - Copy the OTP, paste back into the SPA → confirm sign-in succeeds
   - In a separate terminal: `docker exec -it mgrin-security-audit-postgres-1 psql -U scani -d scani -c "SELECT identifier, length(value), value FROM user_verifications ORDER BY \"createdAt\" DESC LIMIT 3;"` → confirm the `value` column is a hex/base64 hash (~44+ chars), NOT a 6-digit OTP code.

2. **M3 — sessions.revoke is rate-limited:**
   - With a signed-in session, open browser DevTools → console
   - Run a loop calling the revoke mutation:
     ```js
     for (let i = 0; i < 15; i++) {
       const r = await fetch('/api/trpc/sessions.revoke?batch=1', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         credentials: 'include',
         body: JSON.stringify({ 0: { json: { token: 'nonexistent-token' } } }),
       });
       console.log(i, r.status);
     }
     ```
   - Expected: first 10 return 404 (`NOT_FOUND` because the token doesn't exist), 11th onwards return 429 (`TOO_MANY_REQUESTS`).

3. **L4 — change-email is rate-limited:**
   - From the same DevTools console:
     ```js
     for (let i = 0; i < 8; i++) {
       const r = await fetch('/api/auth/change-email', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         credentials: 'include',
         body: JSON.stringify({ newEmail: `target+${i}@example.com` }),
       });
       console.log(i, r.status);
     }
     ```
   - Expected: 7th or 8th call returns 429 (limit is 6/hour).

4. **L5 — change-email requires fresh session:**
   - Sign in, wait 6 minutes (or manually set `freshAge: 1` in dev and wait 2 seconds — easier)
   - Then try change-email → expect `SESSION_EXPIRED` error (per Better-Auth's `update-user.mjs:307`)

Stop the stack:

```
bun dev:stack:down
```

- [ ] **Step 5: Push and open the PR**

Use the project's `wt` CLI as in PR #48:

```bash
wt pr "security: PR2 — auth hardening (hash tokens, SameSite=Strict, per-user rate limits, fresh-session)" --ready
```

After `wt pr` opens the PR, set the body:

```bash
gh pr edit <pr-number> --body "$(cat <<'EOF'
## Summary

Six auth-surface findings closed from the 2026-05-25 security audit. Plan: \`docs/superpowers/plans/2026-05-26-security-hardening-pr2-auth.md\`.

- **M1 — Hash magic-link / OTP tokens in DB.** Better-Auth's \`magicLink\` plugin defaulted to \`storeToken: "plain"\` and \`emailOTP\` likewise. A read-only DB leak handed an attacker 15-min valid magic-links. Added \`storeToken: 'hashed'\` and \`storeOTP: 'hashed'\` — plugin now SHA-256 hashes before storing.
- **M4 — SameSite=Strict on session cookie.** \`Lax\` permitted top-level GET navigations to carry the cookie cross-site. Magic-link click-from-email is unaffected (establishes a new session via \`Set-Cookie\`, not reads an existing one).
- **M3 — Per-user rate limit on sessions.revoke + revokeOthers.** Was unlimited per-user; a compromised session could loop-revoke the victim's other devices. 10/min budget. Added \`InflowRateLimiter.tryConsumeKey()\` and \`createSessionRevokeLimiter\` factory.
- **L4 — Extend signup limiter to /change-email + /change-password.** Closes inbox-spam and brute-force surfaces on Better-Auth's built-in endpoints.
- **L5 — Session freshAge=300.** Better-Auth's \`/change-email\` and \`/change-password\` reject with \`SESSION_EXPIRED\` when the session is older than freshAge. 5-min window forces re-auth before recovery-grade ops.
- **M2 — Account enumeration verification.** Audited each remaining auth endpoint post-PR1's H1 fix; \`/sign-up/email\` and \`/sign-in/email\` are dead, the OTP/magic-link request endpoints are uniform-response by design. [Confirmed safe / Normalized X endpoint — fill in per Task 6 outcome].

## Test plan

- [x] \`bun run type-check\` — clean
- [x] \`bun lint:fix\` — clean
- [x] \`bun test\` — full suite pass
- [x] New tests:
  - \`apps/backend/api/tests/auth/better-auth-config.test.ts\` — M1, M4, L5 config introspection (4 cases)
  - \`packages/infra/rate-limiter/tests/inflow/per-user.test.ts\` — M3 tryConsumeKey (3 cases)
- [x] Manual: DB row inspection confirms hashed OTP / magic-link tokens
- [x] Manual: sessions.revoke returns 429 after 10 calls/min per user
- [x] Manual: /change-email returns 429 after 6 calls/hour per IP
- [x] Manual: /change-email returns SESSION_EXPIRED when session > 5 min old

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Branch strategy

This plan assumes PR #48 is already merged. If it isn't when you start:

**Option A — Stacked PR (recommended if PR #48 will merge within a day):** Create a new branch off `mgrin/security-audit` (PR #48's HEAD):

```bash
wt new mgrin/security-pr2-auth --from mgrin/security-audit
```

The PR will target `main` but include PR #48's commits until #48 merges. After #48 merges, GitHub auto-rebases.

**Option B — Wait:** Sit on this plan until PR #48 merges, then create a new worktree off the fresh `main`:

```bash
wt new mgrin/security-pr2-auth
```

Either way works; the plan content is the same.

---

## Self-Review

**Spec coverage:**
- M1 (hash tokens) → Task 1 ✓
- M4 (SameSite=Strict) → Task 2 ✓
- M3 (sessions.revoke rate limit) → Task 3 ✓
- L4 (change-email/password rate limit) → Task 4 ✓
- L5 (session freshAge) → Task 5 ✓
- M2 (enumeration verification) → Task 6 ✓
- Verification gate → Task 7 ✓

**Placeholder scan:** Every code block is complete. Task 6 is intentionally a research-then-conditional-fix task — the conditional fix has full code if it's triggered; the "documentation-only" branch is also fully specified. No TBDs. ✓

**Type consistency:**
- `tryConsumeKey(identity: string, tokens?: number): Promise<{ok: true} | {ok: false; retryAfterSec: number}>` is used identically in Task 3 Step 3 (definition), Step 5 (factory caller), Step 8 (route caller), and the test in Step 1. ✓
- `InflowRateLimiter` is the type-import name used everywhere (matches the package's existing export). ✓
- `createSessionRevokeLimiter` and `sessionRevokeLimiter` are spelled consistently. ✓
- `storeToken: 'hashed'` / `storeOTP: 'hashed'` are the literal-string config values Better-Auth expects (verified against `node_modules/better-auth/dist/plugins/magic-link/index.mjs:31` where `opts.storeToken === "hashed"`). ✓

**Out-of-scope check:** Plan does not touch encryption (H4), CSP report-uri (L2), SVG (M7), passkeys (L6), or data-provider auth. All deferred to later PRs. ✓
