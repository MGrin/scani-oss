## `@scani/cloud-client`

Typed tRPC client for `apps/backend/data-provider` plus the dispatch layer
that backend + worker use to call into it. Tier 2 routes platform processing through `processing.v1` and retains local S3.
Tier 1 uses direct providers. Legacy/managed deployments retain internal cloud storage.

## What's inside

```
src/
├── client.ts              createCloudClient + types — the typed tRPC proxy
├── errors.ts              CloudError — wraps TRPCClientError so domain code
│                          pattern-matches on `code` without importing tRPC
├── config.ts              loadCloudClientConfig — zod-validated env loader
│                          (SCANI_CLOUD_URL + SCANI_CLOUD_API_KEY)
├── runtime.ts             getCloudClient / setCloudClient / resetCloudClient
│                          (process-wide singleton holder + Sentry sink)
├── health-probe.ts        probeDataProvider — boot-time reachability check
├── cloud-services/        Typed wrappers around individual data-provider routes.
│   ├── cloud-email-service.ts    (always cloud — used by EmailFacade)
│   ├── cloud-storage.ts          (always cloud — used by StorageFacade)
│   └── cloud-og-client.ts        (always cloud — no local equivalent)
├── facades/               @Service() dispatchers that pick local OR cloud
│   ├── email-facade.ts           EmailFacade → cloud or LocalEmailService
│   └── storage-facade.ts         StorageFacade → cloud or StorageService
└── index.ts               Pure barrel — no logic
```

## cloud-services vs facades

`providers/` adapts the existing pricing, AI and public-wallet capability interfaces
into versioned cloud calls. Application composition roots select these only for
`SCANI_DEPLOYMENT_TIER=2`; personal exchange/broker providers remain local.

`StorageFacade` always selects local S3 in Tier 1 and Tier 2. `EmailFacade`
selects local mail in Tier 1, fixed cloud auth templates in Tier 2, and the
internal email relay for legacy/managed deployments. Generic mail is refused
in Tier 2. Merely configuring a cloud key does not select a deployment tier.

OG has only a cloud-service (no facade) because there's no local OG
implementation in the codebase — the data-provider owns it even in the
OSS tier (where it runs as a docker-compose sidecar).

## Configuration

The package owns its own env shape via a zod schema (`src/config.ts`).
Apps that depend on `@scani/cloud-client` MUST NOT redeclare these in
their own env validators — they just set the env vars and the runtime
loads them lazily.

| Env var | Required | Purpose |
|---|---|---|
| `SCANI_DEPLOYMENT_TIER` | explicit for self-hosting | `1`: local providers/storage/mail; `2`: cloud providers/auth mail and local storage; `3` or unset: legacy managed routing. |
| `SCANI_CLOUD_URL` | Tier 2 in every environment; otherwise production | Data-provider endpoint. Tier 1 OSS: `http://data-provider:8082`; Tier 2/3: `https://api.cloud.scani.xyz`. Unset in dev = local-fallback mode. |
| `SCANI_CLOUD_API_KEY` | Tier 2 in every environment; otherwise production (≥ 16 chars) | Bearer token sent on every outbound request. The data-provider validates it against its own `DATA_PROVIDER_API_KEY` (env) or the `cloud_api_keys` table. |

Tier 2 fails to load without both cloud settings in every environment. Other
tiers require them in production (except the isolated demo); development can
omit them to use local services. Public production endpoints require HTTPS.

## Usage

### Boot — health probe

```ts
import { probeDataProvider } from '@scani/cloud-client/health-probe';

const probe = await probeDataProvider();
if (!probe.ok) {
  console.error(`Data-provider unreachable at ${probe.url}: ${probe.error}`);
  // Report degraded processing without taking local data access offline.
}
```

The probe is a no-op when `SCANI_CLOUD_URL` is unset.

### Routers / processors — facades

```ts
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { Container } from 'typedi';

const storage = Container.get(StorageFacade);
const buf = await storage.read(key); // cloud or local — caller doesn't care
```

```ts
import { EmailFacade } from '@scani/cloud-client/facades/email-facade';
import { Container } from 'typedi';

const email = Container.get(EmailFacade);
await email.sendMagicLink({ to, url });
```

### Direct cloud-service use (rare)

When you need cloud-only behaviour (no local fallback), import the
cloud-service directly:

```ts
import { createCloudOGClient } from '@scani/cloud-client/cloud-services/cloud-og-client';
import { getCloudClient } from '@scani/cloud-client/runtime';

const client = getCloudClient();
if (!client) throw new Error('OG fetch requires SCANI_CLOUD_URL');
const og = createCloudOGClient(client);
const meta = await og.fetchMetadata(url);
```

### Manual client construction (rarer)

```ts
import { createCloudClient, loadCloudClientConfig } from '@scani/cloud-client';

const { SCANI_CLOUD_URL: url, SCANI_CLOUD_API_KEY: apiKey } = loadCloudClientConfig();
if (!url || !apiKey) throw new Error('cloud mode required');
const client = createCloudClient({ url, apiKey });
```

## Errors

Cloud-services wrap upstream errors as `CloudError`. Domain code pattern-
matches on `error.code` (`TIMEOUT`, `TOO_MANY_REQUESTS`,
`PRECONDITION_FAILED`, …) without importing tRPC. The `retryable` flag is
pre-set for codes where retry is safe (transient upstream 5xx, rate
limits, timeouts). The original `TRPCClientError` is preserved on
`error.cause` so Sentry sees the upstream root cause.

```ts
import { CloudError } from '@scani/cloud-client';

try {
  await storage.read(key);
} catch (err) {
  if (err instanceof CloudError && err.code === 'NOT_FOUND') return null;
  throw err;
}
```

## Testing

```bash
bun test packages/clients/cloud-client --timeout 30000
```

Facade and provider tests cover explicit tier selection, local S3 with a cloud
client configured, cloud processing, and managed routing. Test fixtures reset
both `resetCloudClientConfig()` and `resetCloudClient()` between cases.

## Why this package exists

Three problems it solves at once:

1. **Single HTTP boundary** between Scani's web tier and the third-party
   API tier. The data-provider can be a sidecar (OSS) or a hosted
   service (Tier 2/3) — backend / worker code doesn't change.
2. **Local-fallback dispatch** so contributors can run the stack without
   the data-provider sidecar. Facades pick the right path lazily.
3. **Typed wire** via the data-provider's `AppRouter` — calls
   auto-complete, bad payloads fail at compile time, no hand-written
   request shapes.
