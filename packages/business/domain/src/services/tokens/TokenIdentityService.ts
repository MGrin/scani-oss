import {
  mergeIdentityDeltas,
  type NewToken,
  type Token,
  type TokenMetadata,
} from '@scani/db/schema';
import type { DatabaseTransaction } from '@scani/db/transaction';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { isFiatCode } from '@scani/providers/core/utils/fiat-codes';
import { Container, Service } from 'typedi';
import { decodeProviderText, decodeProviderTextOptional } from '../../lib/decode-provider-text';
import { TokenTypeRepository } from '../../repositories/EnumRepositories';
import { TokenRepository } from '../../repositories/TokenRepository';
import { BaseService } from '../BaseService';
import { SCAM_SCORE_VERSION, ScamTokenDetectionService } from './ScamTokenDetectionService';
import { judgeTokenIdentity } from './token-identity-safety';

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

/**
 * What one lookup pass established: the row this identity already resolves
 * to, plus the normalized components a create would need. Carried between
 * the two halves so the find-only caller runs the identical lookup rather
 * than a second implementation of it that can drift.
 */
interface ResolvedIdentity {
  existing: Token | null;
  symbol: string;
  name: string | undefined;
  effectiveTypeId: string;
  marketSegment: string | null;
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
    const resolved = await this.resolveIdentity(partial, 'findOrCreateByIdentity', transaction);
    if (resolved.existing) return resolved.existing;
    return await this.createFromIdentity(partial, resolved, transaction);
  }

  /**
   * The lookup half of `findOrCreateByIdentity`, on its own: the row this
   * identity already resolves to, or `null`.
   *
   * Wallet-derived transaction imports need exactly this. They resolve
   * holdings FIND-ONLY — only what the user kept at wallet review — and a
   * holding cannot exist without a `tokens` row, so an identity the database
   * does not already know can never yield one. Creating it is work whose
   * every result is then discarded, and the row it leaves behind is the
   ***REMOVED***
   ***REMOVED***
   ***REMOVED***
   */
  async findByIdentity(
    partial: Partial<NewToken>,
    transaction?: DatabaseTransaction
  ): Promise<Token | null> {
    return (await this.resolveIdentity(partial, 'findByIdentity', transaction)).existing;
  }

  private async resolveIdentity(
    partial: Partial<NewToken>,
    caller: string,
    transaction?: DatabaseTransaction
  ): Promise<ResolvedIdentity> {
    if (!partial.symbol) {
      throw new Error(`${caller}: partial.symbol is required`);
    }
    if (!partial.typeId) {
      throw new Error(`${caller}: partial.typeId is required`);
    }

    // Provider display text is decoded HERE, beside the uppercasing, because
    // this is the one place every provider's token identity is normalised —
    // balance imports arrive through `TokenService.findOrCreateTokenFromIntegration`
    // and transaction imports through `TransactionRouter`, and both land on
    // this method. IBKR serves an HTML-derived instrument description, so
    // `S&P 500` reached the database as `S&amp;P 500` and every consumer saw
    // it: the phone, the exports, the PDF, and search — where somebody typing
    // `S&P` matches nothing at all (SC-276).
    //
    // Not decoded at render, deliberately. That leaves the row itself wrong.
    const symbol = decodeProviderText(partial.symbol).toUpperCase();
    const name = decodeProviderTextOptional(partial.name);
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
    // Fiat is never market-segmented: a fiat-coded symbol resolves to the
    // single canonical seeded row. Forcing the segment to null here keeps
    // a stock-provider payload (which carries `marketSegment: 'US'`) from
    // creating a segmented, stock-named fiat token that coexists with the
    // canonical one under the `(symbol, type, segment)` unique index.
    const marketSegment = isFiatCode(symbol)
      ? null
      : (partial.marketSegment ??
        (evmChainId && evmContract ? `evm:${evmChainId}:${evmContract.toLowerCase()}` : null));
    const base = { symbol, name, effectiveTypeId, marketSegment };

    if (evmChainId && evmContract) {
      const byContract = await this.tokenRepository.findByEvmContract(
        evmChainId,
        evmContract,
        transaction
      );
      if (byContract) return { ...base, existing: byContract };
    }

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
    if (byTuple) return { ...base, existing: byTuple };

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
          return {
            ...base,
            existing: await this.tokenRepository.updateMarketSegment(
              byNullSegment.id,
              marketSegment,
              transaction
            ),
          };
        }
      }
    }

    return { ...base, existing: null };
  }

  /**
   * The create half. Only reached when `resolveIdentity` found nothing, so
   * every early return above is a row that already existed.
   */
  private async createFromIdentity(
    partial: Partial<NewToken>,
    resolved: ResolvedIdentity,
    transaction?: DatabaseTransaction
  ): Promise<Token> {
    const { symbol, name, effectiveTypeId, marketSegment } = resolved;
    const inboundMetadata = (partial.providerMetadata ?? {}) as TokenMetadata;

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
        const merge = mergeIdentityDeltas(
          inboundMetadata as Record<string, unknown>,
          deltas as ReadonlyArray<Record<string, unknown> | null>
        );
        enrichedMetadata = merge.merged as TokenMetadata;
        for (const reason of merge.refused) {
          this.logDebug('Identity enrichment refused: contradicts the row identity', {
            symbol,
            reason,
          });
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
    let scamScoreVersion: number | null = null;
    // `unscored` until the function actually runs. A stock's 0 is the absence
    // of a verdict, not a stale one: scored as if it were crypto,
    // `AMAZON.COM INC` returns 0.50 — a literal dot and a three-character TLD
    // — which is over the 0.35 threshold and would drop Amazon out of the
    // portfolio total (SC-286).
    let scamScoreSource = 'unscored';
    const tokenType = await this.tokenTypeRepository.findById(effectiveTypeId, transaction);
    if (tokenType?.code === 'crypto') {
      scamProbability = this.scamDetectionService.calculateScamProbability(
        symbol,
        // The DECODED name, and the decoded symbol above it. Scoring happens
        // after the decode on purpose: the detector must see the string that
        // will actually be stored and shown, not its encoded form. `&amp;` and
        // `&#39;` add characters a homoglyph or URL heuristic can trip on, and
        // scoring one string while storing another is how a verdict stops
        // describing the row it is attached to (SC-276, on top of SC-207).
        name ?? symbol,
        new Date()
      );
      scamScoreVersion = SCAM_SCORE_VERSION;
      scamScoreSource = 'heuristic';
    }

    // Judge the identity from the characters themselves. The SYMBOL half
    // is independent of the score, and deliberately so: a homoglyph
    // symbol scores 1.00 while we hold no price for it and 0.70 once we
    // do, because "no pricing data available" is worth 0.30 — a fact
    // about OUR coverage that the token has no part in.
    // `WarmTokenPricesForImport` then re-scores priced tokens downward.
    // Quarantine cannot depend on a number that moves for reasons the
    // token did not cause (SC-197).
    //
    // The NAME half takes the score as one of two required signals, and
    // it must be THIS score — computed just above, from symbol and name,
    // with `hasPriceData: false`. It is deterministic and it is never
    // written back, so it does not inherit the drift above (SC-207). A
    // bare-host name refuses only in conjunction with it: no rule over
    // the string separates `BOOKING.COM` from `Draf.io`, and getting
    // that wrong in either direction has already cost us both a blocked
    // import (SC-220) and seven admitted scam rows (SC-224).
    const identityVerdict = judgeTokenIdentity({
      symbol,
      name,
      scamProbability,
    });

    // Hard-reject names that are instructions rather than names — a
    // `✅ SWAP YOUR VOUCHER ON T.LY/SHIBASWAP` has no reading that is a
    // token identity and no balance behind it worth preserving. The
    // score's own 0.95 gate stays as the second line, for the URL-laden
    // and emoji-laden shapes it already caught; 0.95 keeps its
    // false-positive rate at zero because bucket-90 holds genuine
    // memecoins (LOOKS, MATIC) we do not want to swallow.
    //
    // A LOOKALIKE SYMBOL IS NOT REJECTED HERE. It is created and
    // permanently marked, because the danger is that the row is
    // indistinguishable from the real one, not that it exists — and the
    // case that actually matters is a user who was tricked into BUYING
    // one and holds a real balance. Refusing the row shows them nothing,
    // and nothing reads as safe.
    if (identityVerdict.nameAttack || scamProbability >= 0.95) {
      this.logDebug('Refusing to create obvious-scam token', {
        symbol,
        name,
        scamProbability,
        reasons: identityVerdict.reasons,
      });
      throw new ScamTokenRejectedError(symbol, name ?? symbol, scamProbability);
    }

    if (identityVerdict.lookalike) {
      this.logWarning('Creating token with a lookalike symbol, quarantined', {
        symbol,
        lookalikeOf: identityVerdict.lookalikeOf,
        reasons: identityVerdict.reasons,
      });
    }

    const created = await this.tokenRepository.create(
      {
        symbol,
        name: name ?? symbol,
        typeId: effectiveTypeId,
        marketSegment,
        iconUrl: partial.iconUrl ?? null,
        providerMetadata: enrichedMetadata,
        isScamProbability: scamProbability,
        scamScoreVersion,
        scamScoreSource,
        lookalikeOf: identityVerdict.lookalikeOf,
        isActive: true,
      },
      transaction
    );
    this.assertExists(created, 'Failed to create token from identity');
    return created;
  }
}
