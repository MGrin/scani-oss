# `wise/`

Wise (formerly TransferWise) multi-currency accounts: per-currency
balances and the balance-statement ledger.

## Upstream

- Base: `https://api.wise.com`, on Wise's global quarterly version:
  every path is prefixed `/2026Q4/` (SC-1573).
- Versioning: <https://docs.wise.com/guides/developer/global-versioning>.
  Legacy per-endpoint paths (`/v1`, `/v2`, `/v4`) still work, with at
  least six months' notice before any sunset.
- API ref: <https://docs.wise.com/api-reference>.

## Capabilities

| Capability             | Endpoint                                                              | Notes                                   |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------------- |
| `credential-validator` | `GET /2026Q4/profiles`                                                | Valid when at least one profile returns. |
| `current-balances`     | `GET /2026Q4/profiles/<id>/balances?types=STANDARD`                   | Every profile, merged per currency.     |
| `transactions`         | `GET /2026Q4/profiles/<id>/balance-statements/<balanceId>/statement.json` | Windows of at most 469 days; 5-year horizon. |

Every balance is fiat, so holdings route to Frankfurter for
historical pricing.

## Auth + env

- Per-user personal API token, sent as `Authorization: Bearer <token>`.
  Wise's reference lists `PersonalToken` for all three endpoints.
- No env vars: Scani never holds a Wise token of its own.

## Known quirks + gotchas

- **Statements need SCA** for profiles registered outside US, AU, NZ,
  SG, CA and MY. A personal token there gets a 403 on the statement
  call; balances still work.
- **Fees are separate events.** A statement row's `totalFees` becomes
  a sibling fee event with its own external id.

## Source of truth

Concrete code: `index.ts`.
