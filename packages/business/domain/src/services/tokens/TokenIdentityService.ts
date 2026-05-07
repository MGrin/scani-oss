import type { NewToken, Token, TokenMetadata } from '@scani/db/schema';
import type { DatabaseTransaction } from '@scani/db/transaction';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { isFiatCode } from '@scani/providers/core/utils/fiat-codes';
import { Container, Service } from 'typedi';
import { TokenTypeRepository } from '../../repositories/EnumRepositories';
import { TokenRepository } from '../../repositories/TokenRepository';
import { BaseService } from '../BaseService';
import { ScamTokenDetectionService } from './ScamTokenDetectionService';

// Thrown by `findOrCreateByIdentity` when the supplied symbol+name
// matches the obvious-scam heuristics (score ≥ 0.95). Wallet- and
// transaction-import callers catch this, log a warning, and skip
// the offending event so a single phishing airdrop in a wallet's
// history doesn't abort the entire import.
export class ScamTokenRejectedError extends Error {
  readonly symbol: string;
  readonly tokenName: string;
  readonly scamProbability: number;
  constructor(symbol: string, tokenName: string, scamProbability: number) {
    super(
      `Refusing to materialize obvious-scam token (symbol=${symbol}, name=${tokenName}, score=${scamProbability.toFixed(2)})`
    );
    this.name = 'ScamTokenRejectedError';
    this.symbol = symbol;
    this.tokenName = tokenName;
    this.scamProbability = scamProbability;
  }
}

// TokenIdentityService — federated find-or-create-by-identity flow.
// Mutations of arbitrary token state live in TokenService; this class
// owns only the provider-fanout identity resolution path.
@Service()
export class TokenIdentityService extends BaseService {
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);
  private readonly scamDetectionService = Container.get(ScamTokenDetectionService);

  constructor() {
    super('TokenIdentityService');
  }

  /**
   * `findOrCreateByIdentity` — the federated identity flow callers
   * use to materialize a `Token` row from a partial provider-supplied
   * identity (symbol / contract / chain / venue-native id).
   *
   * Flow (synchronous, exhaustive):
   *
   *   1. **Lookup by EVM contract** if `partial.providerMetadata.etherscan`
   *      is populated. The jsonb expression index makes this O(1)
   *      against `(chainId, contractAddress)` regardless of how many
   *      tokens exist with the same symbol.
   *
   *   2. **Lookup by `(symbol, typeId, marketSegment)`**. The
   *      3-tuple unique constraint added in migration 0055 lets
   *      us disambiguate `AAPL` US vs `AAPL.L` LSE vs `AAPL.TO`
   *      Toronto by their structural `marketSegment` rather than
   *      rolling separate tokens for each exchange.
   *
   *   3. **Enrichment** — every registered `TokenIdentityProvider`
   *      runs in parallel against the partial. Each returns a
   *      namespace-scoped `Partial<TokenMetadata>` delta; the base
   *      merges them all. **No first-match-wins** — a brand-new
   *      token always tends toward "every provider that knows about
   *      it has tagged it" before the row is persisted, so
   *      subsequent pricing/balance/tx calls don't have to re-probe.
   *
   *   4. **Persist** the row with the fully-enriched
   *      `providerMetadata` and the `marketSegment` column.
   *
   * Idempotent: callers can re-run with the same partial and get
   * the same row back. Safe to call inside a transaction; pass
   * `transaction` so the create lands in the caller's outer tx.
   */
  async findOrCreateByIdentity(
    partial: Partial<NewToken>,
    transaction?: DatabaseTransaction
  ): Promise<Token> {
    if (!partial.symbol) {
      throw new Error('findOrCreateByIdentity: partial.symbol is required');
    }
    if (!partial.typeId) {
      throw new Error('findOrCreateByIdentity: partial.typeId is required');
    }

    const symbol = partial.symbol.toUpperCase();
    const inboundMetadata = (partial.providerMetadata ?? {}) as TokenMetadata;

    // Fiat ISO-4217 invariant. The Kraken transaction-import path used
    // to default `typeId` to the crypto type id whenever a transaction
    // event didn't carry one, which led to USD/EUR/GBP/CHF being
    // duplicated as crypto-typed tokens (one row per fiat for every
    // user with a Kraken account). Pricing then routed those rows
    // through Finnhub/CoinGecko, which either 403'd or returned a
    // scam-token quote. Any token whose symbol matches the canonical
    // fiat ISO-4217 set MUST be type=fiat — fail-loud override.
    let effectiveTypeId = partial.typeId;
    if (isFiatCode(symbol)) {
      const fiatType = await this.tokenTypeRepository.findByCode('fiat', transaction);
      if (fiatType && fiatType.id !== partial.typeId) {
        this.logDebug('Fiat ISO-4217 invariant: forcing typeId=fiat for fiat-coded symbol', {
          symbol,
          suppliedTypeId: partial.typeId,
          fiatTypeId: fiatType.id,
        });
        effectiveTypeId = fiatType.id;
      }
    }

    // 1. EVM contract lookup — most precise identity. Far stronger
    //    fingerprint than `(symbol, typeId)` for ERC-20s; multiple
    //    chains can have a `USDC` token but only one has the
    //    canonical Circle contract on chain id 1.
    const evmContract = inboundMetadata.etherscan?.contractAddress;
    const evmChainId = inboundMetadata.etherscan?.chainId;
    if (evmChainId && evmContract) {
      const byContract = await this.tokenRepository.findByEvmContract(
        evmChainId,
        evmContract,
        transaction
      );
      if (byContract) return byContract;
    }

    // marketSegment doubles as the tie-breaker for the
    // `tokens_symbol_type_segment_unique` constraint. EVM tokens get
    // `evm:<chainId>:<contractAddress>` synthesized from etherscan
    // metadata so the canonical-USDC-on-each-chain rows can coexist
    // (Ethereum, Polygon, Base USDC are all `(USDC, crypto, …)`); fake
    // ERC-20s with the same symbol but a different contract also
    // coexist as separate rows since their `evm:` segment differs.
    // Without this synthesis, the second USDC create hits the unique
    // constraint and the tx-import drops every event for the second
    // chain's real USDC.
    const marketSegment =
      partial.marketSegment ??
      (evmChainId && evmContract ? `evm:${evmChainId}:${evmContract.toLowerCase()}` : null);

    // 2. Fall through to the `(symbol, typeId, marketSegment)` tuple.
    //    Safe to re-enable for EVM tokens now that marketSegment
    //    incorporates the contract — a scam-USDC won't collide with
    //    real USDC anymore. For non-EVM tokens (kraken, finnhub
    //    stocks) marketSegment stays null and behaves as before.
    const byTuple = await this.tokenRepository.findByIdentityTuple(
      symbol,
      effectiveTypeId,
      marketSegment,
      transaction
    );
    if (byTuple) return byTuple;

    // 2b. Self-healing fallback for stocks: when an exact tuple match
    // misses but the symbol exists with `market_segment IS NULL` (legacy
    // rows from before IBKR balance sync started stamping segments),
    // promote the existing row's segment in place rather than creating
    // a fresh duplicate. Migration 0006 cleared the historical mess;
    // this prevents the next un-segmented import from re-creating it.
    // Scoped to stocks because chain-spread crypto rows intentionally
    // coexist by `evm:<chain>:<contract>` segment — collapsing them
    // there would defeat federated identity.
    if (marketSegment !== null) {
      const stockType = await this.tokenTypeRepository.findByCode('stock', transaction);
      if (stockType?.id === effectiveTypeId) {
        const byNullSegment = await this.tokenRepository.findByIdentityTuple(
          symbol,
          effectiveTypeId,
          null,
          transaction
        );
        if (byNullSegment) {
          this.logDebug('Self-healing: promoting (symbol, type, NULL) → segmented', {
            symbol,
            tokenId: byNullSegment.id,
            newSegment: marketSegment,
          });
          return await this.tokenRepository.updateMarketSegment(
            byNullSegment.id,
            marketSegment,
            transaction
          );
        }
      }
    }

    // 3. Federated enrichment. Every TokenIdentityProvider runs in
    //    parallel — each owns its own namespace key in providerMetadata
    //    and contributes only that key. First-writer-wins per namespace
    //    if two providers happen to claim the same key (logged for
    //    follow-up).
    let enrichedMetadata = inboundMetadata;
    try {
      const registry = Container.get(ProviderRegistry);
      const enrichers = registry.getIdentityEnrichers();
      if (enrichers.length > 0) {
        const deltas = await Promise.all(
          enrichers.map(async (enricher) => {
            try {
              return await enricher.enrichTokenIdentity(partial);
            } catch (err) {
              this.logDebug('TokenIdentityProvider failed; continuing', {
                providerKey: enricher.providerKey,
                error: err instanceof Error ? err.message : String(err),
              });
              return null;
            }
          })
        );
        enrichedMetadata = { ...inboundMetadata };
        for (const delta of deltas) {
          if (!delta) continue;
          for (const [key, value] of Object.entries(delta)) {
            if (key in enrichedMetadata && enrichedMetadata[key] !== undefined) {
              this.logDebug('Identity enrichment namespace collision (keeping first writer)', {
                key,
              });
              continue;
            }
            (enrichedMetadata as Record<string, unknown>)[key] = value;
          }
        }
      }
    } catch (err) {
      // ProviderRegistry not registered yet (boot-time race or
      // direct-mode test). Fall through with the inbound metadata —
      // the nightly BackfillTokenIdentityCronJob will fill in the
      // gaps on the next sweep.
      this.logDebug('ProviderRegistry unavailable; persisting without enrichment', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 4. Scam probability is computed for crypto tokens only.
    //    Symbol/name heuristics drive the score at create time;
    //    price-volatility detection runs later when a price arrives.
    let scamProbability = 0;
    const tokenType = await this.tokenTypeRepository.findById(effectiveTypeId, transaction);
    if (tokenType?.code === 'crypto') {
      scamProbability = this.scamDetectionService.calculateScamProbability(
        symbol,
        partial.name ?? symbol,
        new Date(),
        false
      );
    }

    // Hard-reject obvious scams (URL-laden symbols / phishing payloads
    // like `T.ME/S/US_POOL`, Cyrillic-spoofed `UЅDС`, ✅TRUMP AIRDROP).
    // Threshold 0.95 keeps the false-positive rate at zero — observed
    // bucket-90 contains some genuine memecoins (LOOKS, MATIC) that we
    // do NOT want to silently swallow. ScamTokenRejectedError is
    // typed so the wallet/transaction-import pipelines can catch it
    // and skip the offending event without aborting the whole import.
    if (scamProbability >= 0.95) {
      this.logDebug('Refusing to create obvious-scam token', {
        symbol,
        name: partial.name,
        scamProbability,
      });
      throw new ScamTokenRejectedError(symbol, partial.name ?? symbol, scamProbability);
    }

    const created = await this.tokenRepository.create(
      {
        symbol,
        name: partial.name ?? symbol,
        typeId: effectiveTypeId,
        decimals: partial.decimals ?? 18,
        marketSegment,
        iconUrl: partial.iconUrl ?? null,
        providerMetadata: enrichedMetadata,
        isScamProbability: scamProbability,
        isActive: true,
      },
      transaction
    );
    this.assertExists(created, 'Failed to create token from identity');
    return created;
  }
}
