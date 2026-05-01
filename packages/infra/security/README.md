# @scani/security

Secret-handling primitives. Owns:

- `encrypt(data)` / `decrypt(payload)` — AES-256-GCM with scrypt-derived
  keys; tolerates plaintext on the way back so dev-mode round-trips
  work without ceremony.
- `encryptCredentials(creds)` / `decryptCredentials(envelope)` — wraps
  the raw encryption with an `{ encrypted, data }` envelope so
  encrypted-at-rest rows are distinguishable from dev-mode plaintext
  rows in mixed databases.
- `hasEncryptionKey()` — boolean for callers that want to gate
  production code paths on key availability.
- `loadSecurityConfig()` / `resetSecurityConfig()` — env loader (zod-validated,
  cached). Apps don't normally call this directly; the `encrypt`/`decrypt`
  helpers do it lazily on first use.

## Configuration

The package owns its own env shape via a zod schema (`src/config.ts`).
Apps that depend on `@scani/security` MUST NOT redeclare `ENCRYPTION_KEY`
in their own env validators — they just set the env var and call the
encryption helpers.

| Env var | Required | Purpose |
|---|---|---|
| `ENCRYPTION_KEY` | yes in production (≥ 32 chars) | Either a hex-encoded 32-byte key (64 chars) used directly, or any string from which a 32-byte key is derived via scrypt with salt `scani-salt`. |

In `NODE_ENV=production` the schema fails to load without a key, which
fails the first `encrypt` / `encryptCredentials` call with a clear
error — the alternative would be silently writing exchange API keys to
the database in plaintext, which we never want.

Outside production a missing key produces plaintext output (round-trip
compatible) so local dev and tests can run unconfigured.

The same key MUST be configured on every process that reads the
encrypted columns — today that's `apps/backend/api` and
`apps/backend/worker`. If they disagree, the worker can't decrypt what
the api wrote and every exchange-import silently fails.

## Usage

```ts
import { encryptCredentials, decryptCredentials } from '@scani/security';

// Persist:
const envelope = encryptCredentials({ apiKey, apiSecret });
await db.insert(userIntegrationCredentials).values({ ..., encryptedCredentials: envelope });

// Read back:
const row = await db.select().from(userIntegrationCredentials).where(...).limit(1);
const creds = decryptCredentials(row[0].encryptedCredentials);
//   ^? Record<string, unknown> — caller narrows.
```

The single consumer today is
`packages/business/domain/src/services/IntegrationCredentialsService.ts`.
Future services that need to vault user secrets (OAuth refresh tokens,
2FA seeds, …) should depend on this package rather than rolling their
own crypto.

## Why a separate package

The encryption surface is small (~150 LOC) but the dependency direction
matters: the api / worker / data-provider all need to read encrypted
credentials, but neither the frontend bundle nor the cron jobs that
don't touch user secrets should pull `node:crypto` into their dependency
graph. Keeping it isolated lets `@scani/shared` stay frontend-safe.

## Tests

`bun test packages/infra/security --timeout 30000`

Test cases cover both modes (key set / unset), random-IV uniqueness
across re-encrypts, object round-trips, the dev-mode plaintext fallback,
and the config loader's caching + validation behaviour.
