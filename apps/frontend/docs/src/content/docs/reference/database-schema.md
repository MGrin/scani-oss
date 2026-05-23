---
title: Database schema
description: A summary of every table in the Scani Postgres schema, columns, relationships, and the concept page it implements.
sidebar:
  order: 4
---

The schema lives in `packages/infra/db/src/schema/`. One file per
entity bundle; `schema/index.ts` is the barrel. Migrations live in
`packages/infra/db/src/migrations/` and are registered in
`meta/_journal.json`.

Every relevant concept also has its own page in
[Concepts](/concepts/mental-model/). This page is the dense
schema-only summary.

## Users & sessions

| Table | Purpose | Concept |
|---|---|---|
| `users` | Per-tenant user rows. | — |
| `sessions` | Better-Auth sessions. | — |
| `user_integration_credentials` | Encrypted exchange / brokerage API keys. AES-256-GCM with `ENCRYPTION_KEY`. | [Tier model](/self-hosting/tier-model/) |

## Institutions & accounts

| Table | Purpose | Concept |
|---|---|---|
| `institution_types` | `bank`, `broker`, `crypto_exchange`, `crypto_wallet`, `investment_fund`, `private_equity`, `real_estate`, `other`. | [Accounts](/concepts/accounts/) |
| `institutions` | Catalogue of financial entities — shared across users (manual institution is per-user). | |
| `institution_blockchain_mappings` | Maps blockchain-typed institutions to `(chainId, chainType)`. | |
| `account_types` | `checking`, `savings`, `investment`, `wallet`, etc. | |
| `accounts` | Per-user container for holdings at one institution. `metadata` jsonb holds wallet addresses / chain data. | |

## Tokens & prices

| Table | Purpose | Concept |
|---|---|---|
| `token_types` | `fiat`, `crypto`, `public-stock`, `private-company`, `other`. | [Tokens](/concepts/tokens/) |
| `tokens` | Tradeable assets. Unique key: `(symbol, typeId, marketSegment)` (migration 0055). `providerMetadata` jsonb is namespaced per provider. `unpriceableUntil` is the price-backfill cooldown gate. | |
| `token_prices` | Historical prices. Unique key: `(tokenId, baseTokenId, timestamp, granularity)`. Granularity: `daily`, `intraday`, `tx-exact`. **No USD-canonical column.** | [Pricing](/concepts/pricing/) |
| `token_price_edit_history` | Append-only log of manual price edits for `private-company` / `other` tokens. | [Manual assets](/concepts/manual-assets/) |

## Holdings & ledger

| Table | Purpose | Concept |
|---|---|---|
| `holdings` | Atomic position. `balance` decimal string. `source` (`manual` / `blockchain` / provider name). `externalId` for sync matching. `isHidden` / `isActive` flags. | [Holdings](/concepts/holdings/) |
| `holding_transactions` | **Append-only ledger.** Every economic event. Loose `kind` (`buy`, `sell`, `deposit`, `withdraw`, `transfer_in`, `transfer_out`, `swap_in`, `swap_out`, `fee`, `reward`, `interest`, `airdrop`, `opening_balance`, `unknown`). Signed `quantity`. `priceNative` in native quote currency. `transferGroupId` / `swapGroupId` for pair-linking. Dedup key: `(holdingId, source, externalId)`. | [Transactions](/concepts/transactions/) |
| `holding_balance_observations` | Append-only point-in-time balance anchors. Sources: `sync-capture`, `statement-close`, `screenshot`, `user-entered`, `manual-correction`. Dedup: `(holdingId, observedAt, source)`. | [Observations](/concepts/observations/) |
| `holding_coverage` | Per-holding metadata. First/last tx and observation, `txSources`, `hasCompleteTxHistory`, `openingBalanceQuantity` (synthesised by reconciliation). | [Observations](/concepts/observations/) |
| `holding_apy_configs` | Per-holding yield rules. `annualRatePct`, `payoutFrequency`, day-of-week/month/year. Drives the `apy-payouts` cron. | [APY & yield](/concepts/apy/) |
| `holding_exclusions` | User-managed exclusion rules per holding. | [Holdings](/concepts/holdings/) |

## Vaults & groups

| Table | Purpose | Concept |
|---|---|---|
| `vaults` | Savings goals. `targetAmount` + `currencyId`. `currentAmount` denormalised sum. | [Vaults](/concepts/vaults/) |
| `vault_holdings` | Junction. `percentage` (1–100). Unique `(vaultId, holdingId)`. | |
| `groups` | User-defined tags. Hex `color`, `displayOrder`. | [Groups](/concepts/groups/) |
| `holding_groups` | Junction. Unique `(holdingId, groupId)`. | |
| `account_groups` | Junction. Unique `(accountId, groupId)`. | |

## Portfolio rollup

| Table | Purpose | Concept |
|---|---|---|
| `portfolio_value_daily` | Daily cache. PK `(userId, scopeKind, scopeId, snapshotDate, baseCurrencyId)`. `scopeKind`: `user`, `institution`, `account`, `holding`. `coverageQuality`: `full` / `partial` / `estimated` / `unknown`. `costBasis` / `realizedPnl` / `unrealizedPnl` decimal strings. | [Rollup](/concepts/rollup/) |

## Async jobs & cloud

| Table | Purpose |
|---|---|
| `user_jobs` | User-initiated async job state (screenshot parses, imports, deletes). |
| `job_heartbeats` | Per-job heartbeat rows; drives the `job-heartbeat-probe`. |
| `admin_audit_log` | Operator actions on api admin endpoints. |
| `user_wallets` | User-tracked blockchain wallet addresses. |
| `cloud_api_keys`, `cloud_usage_events` | Tier 2/3 cloud-management (`CLOUD_MANAGEMENT_ENABLED=true`). |

## Foreign-key semantics

The schema uses three `ON DELETE` behaviours deliberately:

| Behaviour | Used for | Rationale |
|---|---|---|
| `CASCADE` | `userId` references; `accountId` from holdings; `holdingId` from ledger / observations / coverage / APY configs. | Deleting a user / account should remove their data. |
| `RESTRICT` | `tokenId` from holdings; `baseTokenId` from `token_prices`. | Refuse to delete a token / base currency that still has live references. |
| `SET NULL` | Informational token references on transactions: `priceNativeTokenId`, `counterTokenId`, `counterPriceNativeTokenId`, `feeTokenId`. | If a token is dedup-merged (migrations 0006 / 0007), null the reference rather than block the merge. |

## Append-only tables

These are **never updated, never deleted** in normal operation:

- `holding_transactions` (one documented exception: the
  synthesised `opening_balance` row, updated in place by the
  reconciliation flow — at most one per holding per cycle).
- `holding_balance_observations`.
- `token_price_edit_history`.
- `admin_audit_log`.
- `cloud_usage_events`.

See [Why an append-only ledger](/decisions/append-only-ledger/).

## Drizzle types are inferred

Every table file exports its row type via Drizzle's inference:

```ts
export type Holding = typeof holdings.$inferSelect;
export type NewHolding = typeof holdings.$inferInsert;
```

These are the types you reach for in services and repositories.
The codebase deliberately never hand-writes a row interface.

## Where to look in code

- `packages/infra/db/src/schema/` — all schema files + the
  `index.ts` barrel.
- `packages/infra/db/src/migrations/` — generated and hand-written
  SQL.
- `packages/infra/db/src/migrate.ts` — the runner.
- `packages/infra/db/src/connection.ts` — postgres.js client setup.
- `packages/infra/db/src/BaseRepository.ts` — shared repository
  helpers.

## See also

- [Repo layout](/reference/repo-layout/)
- [Adding a database migration](/contributing/adding-a-migration/)
- [Concepts: mental model](/concepts/mental-model/)
