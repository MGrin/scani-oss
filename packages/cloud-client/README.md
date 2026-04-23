# @scani/cloud-client

Typed tRPC client and domain-facing adapters for the [`apps/data-provider`](../../apps/data-provider/)
service. Used by `apps/backend` and `apps/worker` to route every outbound
Scani-managed third-party call through a single HTTP hop.

## What's in here

- `createCloudClient({ url, apiKey, getRequestId })` — a tRPC proxy typed
  against the data-provider's `AppRouter`. Stamps every outgoing request
  with `Authorization: Bearer <apiKey>` and (when provided) the current
  `x-request-id` so backend ↔ data-provider ↔ Sentry traces stitch.
- `CloudError` — a plain `Error` subclass wrapping `TRPCClientError`.
  Domain code pattern-matches on `code` (`TIMEOUT`, `TOO_MANY_REQUESTS`,
  `PRECONDITION_FAILED`, …) without taking a direct dep on tRPC. The
  `retryable` flag is already set for the codes where retry is safe
  (transient upstream 5xx, rate limits, timeouts).
- Domain adapters under `src/adapters/`:
  - `CloudPricingProvider` — matches `@scani/pricing-providers`'s
    `PricingProvider` contract.
  - `CloudAIProviderManager` — duck-types `@scani/ai-providers`'s
    `AIProviderManager`; local `getAvailableProviders` cache refreshed
    via `refreshStatus()` at boot.
  - `CloudChainService` — implements `IBlockchainService`; synchronous
    methods (`isValidAddress`, `getChainId`, `getChainName`) stay local
    for performance, async methods (`getTokenBalances`, `hasActivity`,
    `resolveAddressName`) delegate to the data-provider.
  - `createCloudEmailSender` — matches Fastmail's `sendMail` shape so
    Better-Auth swaps it in unchanged.
  - `CloudStorage` — matches `@scani/storage`'s surface.
  - `createCloudOGClient` — drop-in for the institutions router's
    `extractOG`.
- `storage-facade` (sub-export `@scani/cloud-client/storage-facade`) —
  conditional routing at the call site: when `SCANI_CLOUD_URL` and
  `SCANI_CLOUD_API_KEY` are set, delegates to `CloudStorage`; otherwise
  falls back to the local `@scani/storage` implementation for dev.

## Pattern

Every adapter implements the same interface the domain already depended
on pre-split. Call sites do not branch on tier; they receive a
cloud-backed or a local-backed implementation from the DI container at
boot, and the service layer stays the same.

```ts
import { createCloudClient, CloudPricingProvider } from '@scani/cloud-client';

const client = createCloudClient({
  url: process.env.SCANI_CLOUD_URL!,
  apiKey: process.env.SCANI_CLOUD_API_KEY!,
});
const provider = new CloudPricingProvider({ providerKey: 'coinGecko', client });
```

The same conditional wiring lives in `packages/domain/src/services/*` so a
missing `SCANI_CLOUD_URL` transparently falls back to the in-process
provider (used by `bun dev` without a data-provider sidecar).

## Errors

All adapters wrap upstream errors as `CloudError`. Domain code can safely
re-throw; the Sentry capture path in `apps/backend/src/index.ts` records
the `cause` (underlying `TRPCClientError`) unchanged so the root cause
(e.g. OpenAI 429) is visible in the issue body.
