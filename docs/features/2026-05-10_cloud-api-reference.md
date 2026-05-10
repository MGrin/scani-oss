# Scani Cloud API — Reference

Status: live as of 2026-05-10.
Source of truth for the wire shape: the zod `.input()` schemas in
`apps/backend/data-provider/src/presentation/routers/`. This document
mirrors them; the live OpenAPI spec at `/openapi.json` is generated
from the same annotations and is the canonical machine-readable view.

- **Production base URL**: `https://api.cloud.scani.xyz`
- **OSS / dev base URL**: `http://localhost:8082` (or whatever `SCANI_CLOUD_URL` resolves to)
- **OpenAPI 3.0 spec**: `GET /openapi.json`
- **Browseable reference (Scalar UI)**: `GET /docs`

## Authentication

Every endpoint listed below requires a bearer token:

```
Authorization: Bearer sk_live_<32-hex-chars>
```

- API keys are SHA-256 hashed in the `cloud_api_keys` table; only the
  first 12 characters of the prefix are stored in plaintext for the
  management UI.
- Suspended or cancelled keys fail closed with `401 UNAUTHORIZED`.
- Tier 1 (OSS) deployments accept a single `DATA_PROVIDER_API_KEY` env
  token instead of a DB lookup. The same env token also works in
  Tier 2/3 as a superuser fallback (audited via Sentry).
- Optional `x-request-id` request header is echoed in responses for
  tracing; if absent, the server generates one.

Auth implementation: `apps/backend/data-provider/src/auth/api-key.ts`,
key validation: `apps/backend/data-provider/src/auth/cloud-api-keys.ts`,
context wiring: `apps/backend/data-provider/src/presentation/trpc.ts`.

## Wire format

This service speaks tRPC v10 over HTTP, with **no transformer**
configured. Two equally valid call patterns:

### Direct HTTP (any language)

- **Mutations**: `POST /trpc/<router>.<procedure>` with the input zod
  shape as the raw JSON body.
- **Queries**: `GET /trpc/<router>.<procedure>?input=<URL-encoded JSON>`
  — the entire input object is JSON-encoded into the single `input`
  query parameter.

```bash
# Mutation
curl -X POST https://api.cloud.scani.xyz/trpc/ai.completeText \
  -H 'Authorization: Bearer sk_live_…' \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Say pong","options":{"maxTokens":10,"temperature":0}}'

# Query
curl 'https://api.cloud.scani.xyz/trpc/tokens.search?input=%7B%22query%22%3A%22bitcoin%22%2C%22limit%22%3A3%7D' \
  -H 'Authorization: Bearer sk_live_…'
```

### TypeScript (typed client)

```ts
import { createCloudClient } from '@scani/cloud-client';

const client = createCloudClient({
  url: 'https://api.cloud.scani.xyz',
  apiKey: process.env.SCANI_API_KEY!,
});

const hits = await client.tokens.search.query({ query: 'bitcoin', limit: 3 });
```

The TS client uses tRPC's `httpBatchLink`, so multiple calls in the
same tick are batched onto one HTTP request whose body is
`{"0": <input>, "1": <input>, …}`. This is interoperable with the
direct-HTTP form above; pick whichever fits your stack.

## Endpoints

Grouped by router. `M` = mutation (POST), `Q` = query (GET).

### `pricing` — third-party price feeds

| Procedure | Type | Input | Notes |
|---|---|---|---|
| `pricing.fetchCurrentPrice` | M | `{ providerKey, token, baseCurrency, timestamp? }` | Single token current price. `providerKey` ∈ `coingecko`, `defillama`, `frankfurter`, `finnhub`, `yahoo-finance`. |
| `pricing.fetchCurrentPrices` | M | `{ providerKey, tokens[], baseCurrency, timestamp? }` | Batch variant; provider may fall back to per-token loop. |
| `pricing.fetchHistoricalPrice` | M | `{ providerKey, token, at, baseCurrency }` | Snapshot at a specific instant. |
| `pricing.fetchHistoricalRange` | M | `{ providerKey, token, from, to, baseCurrency }` | Range OHLCV-style series. |
| `pricing.convertRate` | Q | `{ fromCurrency, toCurrency }` | ExchangeRate-API live FX rate. Returns `{rate:"0"}` on upstream failure. |

`token` and `baseCurrency` are full token records — see "Common types"
below. The simplest call: pre-populate the token record from
`tokens.search` and pass it through.

Returns: `PriceQuote | null` (or `PriceQuote[]` for the batch / range
variants). `PriceQuote` shape:
`{ tokenId, baseTokenId, price (decimal string), timestamp, source }`.

```bash
curl -X POST https://api.cloud.scani.xyz/trpc/pricing.fetchCurrentPrice \
  -H 'Authorization: Bearer sk_live_…' -H 'Content-Type: application/json' \
  -d '{"providerKey":"coingecko","token":{"id":"bitcoin","symbol":"BTC","name":"Bitcoin","typeId":"crypto","decimals":8,"iconUrl":null,"providerMetadata":{"id":"bitcoin"},"isScamProbability":0,"isActive":true,"createdAt":"2026-05-10T00:00:00Z","updatedAt":"2026-05-10T00:00:00Z"},"baseCurrency":{"id":"usd","symbol":"USD","name":"US Dollar","typeId":"fiat","decimals":2,"iconUrl":null,"providerMetadata":{"id":"usd"},"isScamProbability":0,"isActive":true,"createdAt":"2026-05-10T00:00:00Z","updatedAt":"2026-05-10T00:00:00Z"}}'
# → { "result": { "data": { "tokenId":"bitcoin","baseTokenId":"usd","price":"80691","timestamp":"…","source":"coingecko" } } }
```

### `chains` — blockchain RPC + balance fetch

| Procedure | Type | Input | Notes |
|---|---|---|---|
| `chains.listConfigs` | Q | _(none)_ | Catalog of supported chains. |
| `chains.getTokenBalances` | M | `{ chainId, address }` | Native + ERC-20 / SPL balances for an address. |
| `chains.hasActivity` | M | `{ chainId, address }` | Cheap activity probe. Rate-limited to 30 req/min/key. |
| `chains.resolveAddressName` | M | `{ chainId, address }` | ENS-style reverse lookup if available. Same rate limit as `hasActivity`. |

Supported `chainId` values: `1` (Ethereum mainnet), `137` (Polygon),
`56` (BSC), `42161` (Arbitrum), `10` (Optimism), `8453` (Base), and the
non-numeric strings `bitcoin`, `solana`, `tron`, `ton` for non-EVM
chains. `chains.listConfigs` returns the authoritative current list.

```bash
curl -X POST https://api.cloud.scani.xyz/trpc/chains.hasActivity \
  -H 'Authorization: Bearer sk_live_…' -H 'Content-Type: application/json' \
  -d '{"chainId":1,"address":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"}'
# → { "result": { "data": true } }
```

### `tokens` — federated token search + identity enrichment

| Procedure | Type | Input | Notes |
|---|---|---|---|
| `tokens.search` | Q | `{ query (1–100 chars), limit (1–50, default 10) }` | Fans out to every provider that implements `searchTokens`; results deduped on `provider:symbol`. |
| `tokens.enrichIdentity` | M | `{ providerKey, partial, force? }` | Fill in a partial token record using a specific identity provider. |

Returns from `tokens.search`: `Array<{ symbol, name, type, currency,
provider, providerMetadata }>` — see `TokenSearchResult` in
`packages/clients/providers/src/core/capabilities.ts`.

```bash
curl 'https://api.cloud.scani.xyz/trpc/tokens.search?input=%7B%22query%22%3A%22ethereum%22%2C%22limit%22%3A2%7D' \
  -H 'Authorization: Bearer sk_live_…'
```

### `ai` — LLM endpoints

| Procedure | Type | Input | Notes |
|---|---|---|---|
| `ai.parseScreenshot` | M | `{ imageBase64, options? }` | OCR + structured extraction from a portfolio screenshot. |
| `ai.parseDocumentText` | M | `{ text, options? }` | Same, but from text instead of an image. |
| `ai.completeText` | M | `{ prompt, options? }` | Free-form completion. |
| `ai.status` | Q | _(none)_ | Lists currently-available AI providers. |

`options.provider` selects a specific provider key (`ai-openai`, …);
omit to use the default. `options.fallbackProviders: false` disables
the cross-provider retry chain.

`parseScreenshot` / `parseDocumentText` returns
`{ portfolio, metadata: { provider, processingTime } }`;
`completeText` returns `{ content, provider }`.

### `og` — Open Graph metadata

| Procedure | Type | Input | Notes |
|---|---|---|---|
| `og.fetchMetadata` | Q | `{ url }` | SSRF-hardened OG fetch via `@scani/http-fetch`. Returns the empty-shape on bounded-fetch refusal (private IP, oversized response, …). |

Response: `{ title, description, siteName, image, type, finalUrl, truncated }`.

### `email` — outbound transactional email

| Procedure | Type | Input | Notes |
|---|---|---|---|
| `email.send` | M | `{ from, to, subject, text, html? }` | Pass-through to `LocalEmailService.send`. Backed by Fastmail JMAP in prod, SMTP in dev (Mailpit). |

Returns `{ ok: true }` on success. Any upstream failure surfaces as
`INTERNAL_SERVER_ERROR`.

### `storage` — Cloudflare R2 access

| Procedure | Type | Input | Notes |
|---|---|---|---|
| `storage.presignUpload` | M | `{ keyPrefix, extension, contentType, contentLength, ttlSeconds? }` | Browser-direct PUT URL. |
| `storage.presignDownload` | Q | `{ key, ttlSeconds? }` | Time-bounded GET URL. |
| `storage.readTempBlob` | M | `{ key }` | Reads the blob server-side and returns it as base64 — for the rare read-on-server path. |
| `storage.deleteTempBlob` | M | `{ key }` | Idempotent delete. |

R2 credentials live in this service; callers never see them.

## Common types

### `Token`

Full token record passed to pricing endpoints. Mirrors the `tokens`
table in the backend DB; the data-provider only reads
`id`, `symbol`, and `providerMetadata`.

```ts
{
  id: string;
  symbol: string;
  name: string;
  typeId: string;
  decimals: number;
  iconUrl: string | null;
  providerMetadata: unknown;     // shape varies by provider
  isScamProbability: number;
  isActive: boolean;
  marketSegment?: string | null;
  createdAt: Date;               // accepted as ISO-8601 string
  updatedAt: Date;
}
```

For pricing calls you control, the minimal viable record is:
`{ id, symbol, name, typeId, decimals, iconUrl: null, providerMetadata: { id: "<provider-id>" }, isScamProbability: 0, isActive: true, createdAt, updatedAt }`.

## Errors

Every error is a tRPC `error` envelope:

```json
{ "error": { "message": "…", "code": -32001,
             "data": { "code": "UNAUTHORIZED", "httpStatus": 401, "path": "tokens.search" } } }
```

| `data.code` | `httpStatus` | When |
|---|---|---|
| `UNAUTHORIZED` | 401 | Missing / invalid bearer token, or key is suspended/expired. |
| `BAD_REQUEST` | 400 | Input fails zod validation. |
| `NOT_FOUND` | 404 | Calling a query as POST or vice versa; unknown procedure path. |
| `TOO_MANY_REQUESTS` | 429 | Per-key probe limit hit (`chains.hasActivity` / `chains.resolveAddressName`). |
| `INTERNAL_SERVER_ERROR` | 500 | Upstream provider failed, or unknown `providerKey`. |
| _(503)_ | — | Returned by `/ready` while the service is still booting and by `email.send` when the management plane is wired but cloud DB hasn't loaded. |

The `x-request-id` response header is the trace key — include it when
filing a support ticket.

## Rate limits & quotas

- **Per-key hourly request quota**: configured globally via
  `CLOUD_QUOTA_HOURLY_DEFAULT` (managed deployments). 0 / unset = no
  quota. Trips a `FORBIDDEN { code: 'quota_exceeded' }` when hit.
- **Org-wide cost circuit breaker**: cumulative `upstreamCostUsd`
  across all tenants is capped per hour by `GLOBAL_HOURLY_USD_CAP`.
  When tripped, every bearer endpoint returns 503 until the next
  hour bucket.
- **Per-procedure address probes**: `chains.hasActivity` and
  `chains.resolveAddressName` are limited to 30 requests/minute/key.
- **Per-provider upstream limiters**: CoinGecko / Etherscan / Helius
  / etc. each have their own Redis-backed token bucket shared
  across data-provider replicas — surfaces as `INTERNAL_SERVER_ERROR`
  with a provider-specific message when exceeded.

## Public unauthenticated endpoints

| Path | Purpose |
|---|---|
| `GET /` | Service identity. |
| `GET /health` | Liveness probe. |
| `GET /ready` | 200 once boot is fully done; 503 during startup. |
| `GET /health/r2` | R2 bucket reachability + latency. |
| `GET /openapi.json` | Generated OpenAPI 3.0 spec for everything in this document. |
| `GET /docs` | Scalar API reference UI loaded against `/openapi.json`. |

## Versioning

The OpenAPI document's `info.version` field is set from the
`SENTRY_RELEASE` env var, so it tracks the deployed Git SHA. The
shape of any specific procedure is the responsibility of the zod
schema in its router file — adding optional fields is non-breaking;
removing or renaming required fields is breaking and warrants a
prefixed parallel procedure (`tokens.searchV2`, …).
