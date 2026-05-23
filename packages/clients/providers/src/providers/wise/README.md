# `wise/`

Wise (formerly TransferWise) multi-currency forex rates. Used by
users with Wise accounts to denominate non-USD balances at Wise's
mid-market rate (which reflects what the user could actually convert
at, vs the ECB rate which is reference-only).

## Upstream

- Base: `https://api.wise.com/v3` (production); sandbox at
  `https://api.sandbox.transferwise.tech/v3`.
- API ref: <https://docs.wise.com/api-docs/api-reference>.

## Capabilities

| Capability         | Endpoint                              | Notes                              |
| ------------------ | ------------------------------------- | ---------------------------------- |
| `current-price`    | `GET /v1/rates?source=…&target=…`     | One pair per call.                 |
| `current-balances` | `GET /v4/profiles/<id>/balances`      | Multi-currency account balances.   |

`canPrice(t)` returns true for the small set of currencies Wise
supports as forex pairs (USD, EUR, GBP, AUD, CAD, JPY, CHF, …).
Anything outside that set falls through to Frankfurter / ExchangeRate-API.

## Auth + env

- Per-user `apiKey` (issued in the Wise dashboard, scoped per profile).
- Header: `Authorization: Bearer <apiKey>`.
- No env vars — Scani never holds Wise keys.

## Rate limit + namespace

- Wise's published cap: 60 req/min per token (variable across
  endpoints).
- Rate-limiter namespace: `wise` (per credential).

## Error taxonomy

- 401 → `kind: auth-failed`. `validateCredentials` translates to
  `{ valid: false }`.
- 403 → typically the user's API key doesn't have the right scope
  (rates need `accounts:read`); same `auth-failed` mapping.
- 429 → `kind: rate-limited`.
- 5xx → `kind: retryable` (already retried once via
  `fetchWithTimeout`).

## Known quirks + gotchas

- **No historical-price support**. Wise's historical-rate endpoint
  exists (`/v1/rates?from=…&to=…&group=…`) but the response shape
  is awkward (groups of bars per pair) and we haven't ported it.
  Backfill therefore falls through to Frankfurter (ECB rates) for
  fiat pairs that Wise users hold. Follow-up.
- **Profile id required for balances**. Each user has a personal
  profile id and optionally a business profile id. The provider
  currently only walks the personal profile — a multi-profile user
  would miss their business balances. Account discovery is a
  follow-up.
- **Mid-market rate vs offered rate**. The provider returns the
  `rate` field from `/v1/rates`, which is mid-market. Actual
  conversions Wise charges spread on top; we surface mid-market
  because the user wants "fair value" portfolio numbers, not
  "what would Wise charge me to convert right now" numbers.
- **No transactions support today**. Wise has a transfers history
  endpoint (`/v1/profiles/<id>/transfers`) — porting is a
  follow-up. Users who use Scani for balance-only flows are
  unaffected.

## Source of truth

Concrete code: `index.ts`.
