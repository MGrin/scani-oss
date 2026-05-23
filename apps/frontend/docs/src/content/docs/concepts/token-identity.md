---
title: Token identity & enrichment
description: How Scani materialises tokens from partial provider-supplied identities and keeps their cross-provider metadata fresh.
sidebar:
  order: 15
---

## Summary

Ingesters frequently see *partial* token identity — an Etherscan
contract address, a CoinGecko slug, a Kraken asset code — and need a
canonical [token](/concepts/tokens/) row to attach a holding /
transaction / observation to.
`TokenIdentityService.findOrCreateByIdentity()` is the federated flow
that resolves any partial identity into a fully-materialised token,
enriching it across every registered provider in parallel and
persisting the merged result. A weekly `backfill-token-identity` job
re-enriches stale rows so provider metadata stays current as
upstream definitions evolve.

## The resolution flow

For an incoming identity (any subset of `{symbol, type, market segment,
chainId, contractAddress, coingeckoId, krakenAsset, ...}`):

1. **EVM contract lookup** by `(chainId, contractAddress)` against the
   `providerMetadata.etherscan` jsonb path. If found, return.
2. **(symbol, typeId, marketSegment) lookup**. If found, return.
3. **Parallel enrichment** via every registered
   `TokenIdentityProvider`:
   - CoinGecko — adds `providerMetadata.coingecko`.
   - DeFiLlama — adds `providerMetadata.defillama` (the `"chain:address"`
     coin spec used by DeFiLlama's pricing API).
   - Etherscan — adds `providerMetadata.etherscan` (chain + contract).
   - Kraken — adds `providerMetadata.kraken` (raw asset code).
   - Finnhub — adds `providerMetadata.finnhub` (stock symbol + exchange).
   - Solana — adds `providerMetadata.solana` (SPL mint address).
   - …new providers plug in here.
4. **Persist** the new token row with fully-enriched
   `providerMetadata`.

The flow is deterministic per identity input — if two ingest paths
discover the same contract concurrently, both produce the same row
(the unique constraint guarantees one wins; the other reads the
winner).

## First-writer-wins per namespace

`providerMetadata` is a single jsonb with one key per provider. When
two providers disagree on the *same* namespace (rare — usually means
the upstreams genuinely disagree), the first to populate that
namespace wins; the conflict is logged.

This is why adding a new provider is a small change: the new
provider tags its own namespace, and existing providers' data is
untouched.

## The weekly re-enrichment cron

`backfill-token-identity` runs **weekly on Sunday at 02:00 UTC**. It
picks tokens that haven't been touched by an ingester recently and
re-runs the parallel enrichment pass. The job is the safety net for:

- Providers whose definitions evolve (a stock listing moves, a token
  migrates contract addresses).
- Tokens initially materialised with only one provider's data — the
  weekly pass picks up new providers that didn't exist or weren't
  configured at original creation.

## Scam / unpriceable flags

Two flags on `tokens` are managed alongside identity:

- `isScamProbability` — float 0–1. Tokens above the threshold
  (`SCAM_PROBABILITY_THRESHOLD`) are excluded from totals by the
  [inclusion rule](/decisions/holding-inclusion-rule/). The score is
  populated by enrichment passes that consult provider hints
  (CoinGecko's `is_scam`, DeFiLlama's blacklist, …).
- `unpriceableUntil` — timestamp. Set when the historical-price
  backfill has tried and failed to find prices, so the next pass
  skips this token instead of re-asking the same providers. Cleared
  on the next successful price write.

Both flags are an established-then-trusted model: a single missing
price doesn't flag the token, but a sustained inability does.

## Where to look

| File | Role |
|---|---|
| `packages/business/domain/src/services/tokens/TokenIdentityService.ts` | The federated resolution flow. |
| `packages/clients/providers/src/` — per-provider directories | Each provider's `TokenIdentityProvider` adapter. |
| `packages/business/jobs/src/scheduled-jobs/backfill-token-identity.ts` | Weekly cron descriptor. |

## See also

- [Tokens & market segments](/concepts/tokens/)
- [Pricing & the price graph](/concepts/pricing/)
- [Provider matrix](/reference/provider-matrix/)
- [Glossary: token identity](/reference/glossary/#token-identity)
