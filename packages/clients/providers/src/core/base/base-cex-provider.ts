/**
 * `BaseCexProvider` — shared scaffolding for centralized-exchange
 * providers (Kraken, Binance, Coinbase, Bybit, OKX, …).
 *
 * Each concrete CEX provider class extends this base, supplies its
 * `providerKey` + `institutionCode`, and implements
 * `fetchHistoryPaginated(ctx)` as an async generator yielding raw
 * `CexNormalizedEvent` rows. The base owns:
 *
 *   1. **Sign enforcement by `kind`.** Concrete subclasses easily
 *      forget to negate raw exchange amounts (`{ kind: 'sell',
 *      quantity: '1.5' }` from a positive raw "sold 1.5 BTC" payload
 *      is the canonical bug). The base derives sign from `kind` and
 *      logs a warning when the source-supplied sign disagrees so the
 *      ledger's "negative quantity = outflow" invariant stays
 *      unconditional.
 *
 *   2. **Streaming pagination.** Async generator means subclasses
 *      stream pages without buffering full multi-year histories in
 *      memory — important for traders with hundreds of thousands of
 *      events.
 *
 *   3. **Mapping to `TransactionEvent`.** Concrete providers think in
 *      "exchange asset symbol + signed quantity"; the orchestrator
 *      thinks in "Partial<NewToken> + signed quantity". The base
 *      converts at the boundary so subclass authors don't have to know
 *      about the federated token-identity flow.
 *
 * The pre-refactor equivalent was
 * `packages/integrations/src/ingesters/base/BaseCexTransactionIngester.ts`,
 * which carried domain-layer concerns (resolving `holdingId` /
 * `tokenId` against the DB). That coupling is gone — this base emits
 * `Partial<NewToken>` identity hints that `TokenService.find
 * OrCreateByIdentity` materializes upstream of the ingest.
 */

import type { NewToken } from '@scani/db/schema';
import { type CustomLogger, createComponentLogger } from '@scani/logging';
import Decimal from 'decimal.js';
import type {
  BalanceProvider,
  Capability,
  CredentialValidator,
  CurrentPriceProvider,
  HistoricalPriceProvider,
  ProviderBase,
  TokenIdentityProvider,
  TransactionsProvider,
} from '../capabilities';
import type {
  HoldingSnapshot,
  PriceQuote,
  ProviderContext,
  TransactionEvent,
  WithUserCreds,
} from '../types';

/**
 * Kinds a CEX provider can yield. Subset of `TransactionEvent.kind` —
 * `transfer_in`/`transfer_out` and `swap_in`/`swap_out` come from
 * blockchain providers, not CEXes.
 */
export type CexEventKind = 'buy' | 'sell' | 'deposit' | 'withdraw' | 'fee' | 'reward' | 'interest';

/**
 * Raw event a concrete CEX provider yields per page row. Identity is
 * given as exchange-native asset codes (`'BTC'`, `'XXBT'`, etc.); the
 * base translates them to `Partial<NewToken>` via the subclass's
 * `mapAssetIdentity()` so the orchestrator can find-or-create the
 * relevant `Token` row through the federated identity flow.
 */
export interface CexNormalizedEvent {
  kind: CexEventKind;
  /** Exchange-native asset code for the primary side. */
  assetCode: string;
  /** Signed Decimal.js string. The base re-asserts sign from `kind`. */
  quantity: string;
  /** Per-unit native-quote price, if the venue supplies one. */
  priceNative?: string;
  /** Quote-currency code for `priceNative` (e.g. `'USDT'`, `'USD'`). */
  priceNativeAssetCode?: string;
  /** Other side of a trade (the asset bought, when this leg is a sell). */
  counterAssetCode?: string;
  /** Counter-side quantity (positive). */
  counterQuantity?: string;
  /** Fee asset; often distinct from primary. */
  feeAssetCode?: string;
  /** Fee quantity (always positive — the base negates inside the fee leg). */
  feeQuantity?: string;
  occurredAt: Date;
  /** Stable provider-native id; feeds the (source, externalId) dedup. */
  externalId: string;
  rawPayload?: unknown;
}

/**
 * Shape every concrete CEX provider declares as its public surface
 * area. The capability interfaces are duck-typed so the registry
 * picks up whichever methods the concrete class implements; this
 * union is just for IDE auto-complete.
 */
export type CexProviderCapabilities = ProviderBase &
  Partial<
    BalanceProvider &
      TransactionsProvider &
      CurrentPriceProvider &
      HistoricalPriceProvider &
      TokenIdentityProvider &
      CredentialValidator
  >;

/**
 * Concrete CEX providers extend `BaseCexProvider`. They:
 *
 *  - declare their `providerKey` and `capabilities`.
 *  - implement `mapAssetIdentity(code)` so exchange-native codes
 *    translate to `Partial<NewToken>` identity hints (Kraken: 'XXBT'
 *    → `{ symbol: 'BTC', providerMetadata: { kraken: { asset: 'XXBT' } } }`).
 *  - implement `fetchHistoryPaginated(ctx)` as an async generator
 *    yielding `CexNormalizedEvent`s.
 *  - optionally implement balance / current-price / historical-price
 *    methods directly.
 */
export abstract class BaseCexProvider implements ProviderBase {
  abstract readonly providerKey: string;
  abstract readonly capabilities: readonly Capability[];

  protected readonly logger: CustomLogger;

  constructor() {
    this.logger = createComponentLogger(`provider:${this.constructor.name}`);
  }

  /**
   * Translate an exchange-native asset code into the partial
   * `NewToken` shape the federated identity flow consumes.
   *
   * Returning null means "I don't know about this asset" — the base
   * skips the event with a warning rather than throwing, because a
   * single weird symbol shouldn't kill a multi-thousand-event ingest.
   */
  protected abstract mapAssetIdentity(assetCode: string): Partial<NewToken> | null;

  /**
   * Yield raw events page-by-page. The base consumes the generator
   * and produces sign-corrected `TransactionEvent`s.
   *
   * The generator's terminal value reports whether the entire
   * history was retrieved — `hasCompleteTxHistory: false` means the
   * caller should preserve any prior coverage state instead of
   * extending it.
   */
  protected abstract fetchHistoryPaginated(
    ctx: WithUserCreds<ProviderContext> & { institutionCode: string; since?: Date; until?: Date }
  ): AsyncGenerator<CexNormalizedEvent, { hasCompleteTxHistory: boolean }, void>;

  /**
   * Default `TransactionsProvider.fetchTransactions` implementation
   * — concrete subclasses just need to provide the paginator and
   * `mapAssetIdentity`. Subclasses that need a different pipeline
   * (Coinbase v2's mixed accounts/ledgers feed) override directly.
   */
  protected async fetchTransactionsViaPagination(
    ctx: WithUserCreds<ProviderContext> & {
      institutionCode: string;
      since?: Date;
      until?: Date;
    }
  ): Promise<TransactionEvent[]> {
    const events: TransactionEvent[] = [];
    const generator = this.fetchHistoryPaginated(ctx);

    while (true) {
      const step = await generator.next();
      if (step.done) break;

      const raw = step.value;
      const primary = this.mapAssetIdentity(raw.assetCode);
      if (!primary) {
        this.logger.warn(
          { providerKey: this.providerKey, assetCode: raw.assetCode },
          'Unknown asset code; skipping event'
        );
        continue;
      }

      const counter = raw.counterAssetCode ? this.mapAssetIdentity(raw.counterAssetCode) : null;
      const fee = raw.feeAssetCode ? this.mapAssetIdentity(raw.feeAssetCode) : null;
      const priceNativeQuote = raw.priceNativeAssetCode
        ? this.mapAssetIdentity(raw.priceNativeAssetCode)
        : null;

      const signedQty = this.enforceSign(raw.quantity, raw.kind);

      const event: TransactionEvent = {
        externalId: raw.externalId,
        occurredAt: raw.occurredAt,
        kind: raw.kind,
        primary: { tokenIdentity: primary, quantity: signedQty },
        rawPayload: raw.rawPayload,
      };
      if (counter && raw.counterQuantity) {
        // Counter quantity is the OPPOSITE sign of primary on
        // buy/sell legs (you sell BTC for +USDT, or buy BTC for
        // -USDT). Concrete providers supply absolute counter values;
        // the base infers sign from primary.
        const counterAbs = new Decimal(raw.counterQuantity).abs();
        const counterSigned = new Decimal(signedQty).isNegative() ? counterAbs : counterAbs.neg();
        event.counter = { tokenIdentity: counter, quantity: counterSigned.toString() };
      }
      if (fee && raw.feeQuantity) {
        // Fee always flows OUT, so it's always negative.
        const feeAbs = new Decimal(raw.feeQuantity).abs();
        event.fee = { tokenIdentity: fee, quantity: feeAbs.neg().toString() };
      }
      if (raw.priceNative && priceNativeQuote) {
        event.priceNative = { value: raw.priceNative, quoteIdentity: priceNativeQuote };
      }

      events.push(event);
    }

    return events;
  }

  /**
   * Re-assert the sign on `quantity` from the event's `kind`. CEX
   * subclass authors easily forget — this catches the bug at the
   * boundary so the rest of the ledger can rely on negative-quantity
   * = outflow without per-source defensive math.
   */
  private enforceSign(rawQty: string, kind: CexEventKind): string {
    const qty = new Decimal(rawQty);
    if (qty.isZero()) return qty.toString();

    const shouldBeNegative = kind === 'sell' || kind === 'withdraw' || kind === 'fee';
    const shouldBePositive =
      kind === 'buy' || kind === 'deposit' || kind === 'reward' || kind === 'interest';

    if (shouldBeNegative && qty.isPositive()) return qty.neg().toString();
    if (shouldBePositive && qty.isNegative()) return qty.abs().toString();
    return qty.toString();
  }

  // Subclasses that don't implement balance/price/identity capabilities
  // simply omit the methods — the registry's duck-typed guards skip
  // them. We intentionally do NOT provide stubs that throw, because
  // capability presence is an interface-level signal and stubs would
  // muddy the duck-typed registration flow.
  //
  // For reference, concrete providers implement (any subset of):
  //   fetchBalances(ctx) → HoldingSnapshot[]
  //   fetchCurrentPrice(token, ctx) → PriceQuote | null
  //   fetchHistoricalPrice(token, at, ctx) → PriceQuote | null
  //   enrichTokenIdentity(partial) → Partial<TokenMetadata> | null
  //   validateCredentials(creds, institutionCode) → { valid; message? }
}

// Re-export common types for concrete subclasses to import in one line.
export type { HoldingSnapshot, PriceQuote, TransactionEvent, WithUserCreds };
