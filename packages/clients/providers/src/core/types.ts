/**
 * Runtime-shape types used by providers. Anything that maps to a DB
 * row (Token, NewToken, TokenMetadata) lives in `@scani/db/schema`
 * — see `packages/infra/db/src/schema.ts`. This file holds only types
 * with no DB counterpart: provider request contexts, responses,
 * and ingestion event shapes.
 */

import type { NewToken, Token } from '@scani/db/schema';

/**
 * Plaintext credentials passed by the caller into a provider's
 * self-credentialed methods. Decryption is owned by
 * `IntegrationCredentialsService`; providers never see the encrypted
 * blob. Any subset of these fields may be populated depending on the
 * integration's auth shape.
 */
export interface DecryptedCredentials {
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  accessToken?: string;
  /** Brokers like IBKR keep auth in a paired token + query id. */
  flexQueryToken?: string;
  flexQueryId?: string;
  /** Open-ended for venues that bring their own auth shape. */
  [key: string]: unknown;
}

/**
 * Per-call context every provider method receives.
 *
 * Credentials NEVER appear here as plaintext. Instead the caller
 * supplies `credentialsRef` + `resolveCredentials`; the provider
 * resolves on demand inside its private hot path. This keeps AES-GCM
 * decryption inside `IntegrationCredentialsService` and means no
 * provider can accidentally leak a credential into a log line.
 *
 * Pool-credentialed methods (current/historical pricing, identity
 * enrichment) treat `credentialsRef` as optional — they self-resolve
 * via `CredentialPool` when the caller has no integration. Self-
 * credentialed methods (balances, transactions, validation) require
 * `credentialsRef` at the type level via `WithUserCreds<T>`.
 */
export interface ProviderContext {
  /** Token to denominate prices in. Always a real Token row. */
  baseCurrency: Token;
  /** Wall-clock timestamp the caller wants prices/balances "as of". */
  timestamp?: Date;
  /** Owning user — used for audit trails on pool borrows. */
  userId?: string;
  /** Owning account — for balance / transaction calls. */
  accountId?: string;
  credentialsRef?: { userId: string; institutionId: string };
  resolveCredentials?: (ref: {
    userId: string;
    institutionId: string;
  }) => Promise<DecryptedCredentials>;
  /**
   * Optional phase-message sink for long-running provider calls. The
   * caller (a use case running inside a BullMQ processor) passes a
   * function that pipes to `ProcessorContext.reportStatus`, so the UI
   * can show "Waiting for IBKR — attempt N/24" instead of an opaque
   * indeterminate spinner. Best-effort: providers may invoke or ignore.
   */
  onStatus?: (message: string) => void | Promise<void>;
}

/**
 * Compile-time enforcement that a method requires the caller to supply
 * credentials (no pool fallback). Self-credentialed capabilities use
 * `WithUserCreds<ProviderContext>` in their signatures so passing a
 * context without `credentialsRef` is a type error.
 */
export type WithUserCreds<C extends ProviderContext> = C & {
  credentialsRef: NonNullable<C['credentialsRef']>;
  resolveCredentials: NonNullable<C['resolveCredentials']>;
};

/**
 * The context a `TransactionsProvider.fetchTransactions` call receives.
 *
 * `retractHistoryClaim` is the channel this type exists for (SC-395).
 * Completeness is CLAIMED by `TransactionRouter` — it knows whether the
 * caller asked for the whole ledger and whether the provider declares a
 * look-back horizon — and until now that claim was the only voice. A
 * provider that walked the account and came back knowing it had not
 * reached the end had nowhere to say so: `fetchTransactions` returns
 * `TransactionEvent[]`, and Kraken's paginator computed the verdict into a
 * generator return value the base class dropped on the floor.
 *
 * It is deliberately RETRACTION-ONLY. There is no counterpart that claims
 * completeness, because a provider cannot know what the caller asked for —
 * an incremental `since` run reaches the end of its window every time and
 * would otherwise report a whole ledger. The router claims; the provider
 * can only take the claim away, and `reason` is what the run tells the
 * user in its warnings.
 *
 * Optional because the router is not the only caller — provider tests and
 * the cloud fetcher build their own contexts — and because a provider that
 * has nothing to retract must not have to care.
 */
export type TransactionFetchContext = WithUserCreds<ProviderContext> & {
  institutionCode: string;
  since?: Date;
  until?: Date;
  retractHistoryClaim?: (reason: string, bound?: HistoryBound) => void;
  noteWarning?: (reason: string) => void;
};

/**
 * How far back the walk that just retracted actually reached (SC-900).
 *
 * It rides on `retractHistoryClaim` rather than on a sink of its own, and that
 * is the point rather than a convenience: a bound is only meaningful about a
 * ledger already known to be short, so a provider must not be able to state one
 * while still claiming it read everything. One call, one fact — "I did not get
 * the whole ledger, and this is the earliest date I could see".
 *
 * `historyStartsAt` is the window the SOURCE covers, not the earliest row it
 * sent. A statement covering a date range can report a row dated before that
 * range — an accrued fee, a corrected settlement — so the two are different
 * numbers and only the first one says what was never fetched.
 *
 * Optional on the retraction for the same reason `retractHistoryClaim` is
 * optional on the context: a provider that knows its ledger is short and cannot
 * name a boundary must still be able to say the first half.
 */
export interface HistoryBound {
  historyStartsAt: Date;
}

/**
 * `noteWarning` is the same voice with none of the authority (SC-428).
 *
 * `retractHistoryClaim` is retraction-only BY CONSTRUCTION, and everything it
 * receives is evidence that the ledger is short — it moves
 * `has_complete_tx_history`, which SC-149 made load-bearing for cost basis. So
 * a provider that wants to tell the reader something which is NOT evidence
 * about the ledger has to say it somewhere else, or say nothing.
 *
 * Saying nothing is what bitstamp did. Its `/crypto-transactions/` walk exists
 * to hang an on-chain txid on deposit and withdraw events the ledger walk has
 * already produced, and it has a 200-page cap of its own; exhausting it drops
 * the annotation from some events and drops no rows. SC-426 deliberately left
 * that alone rather than retract on it — a downgraded cost basis over a
 * missing hash would be a worse defect than the missing hash. But then nothing
 * told anyone it had happened.
 *
 * The reader sees these in the same `warnings` list as a retraction; the
 * difference is what the run then WROTE, and only one of the two changes that.
 */

/**
 * Single price datapoint. Stored verbatim in `token_prices` by the
 * orchestrator; `source` is `${providerKey}_${variant}` so audit /
 * de-conflict logic can attribute rows to the provider that produced
 * them.
 */
export interface PriceQuote {
  tokenId: string;
  baseTokenId: string;
  /** Decimal.js string — never a JS number to avoid float drift. */
  price: string;
  /** When the quote is "as of" — may differ from request timestamp
      when the provider returns the closest available bar. */
  timestamp: Date;
  source: string;
}

/**
 * One position observed at a point in time. `tokenIdentity` is a
 * partial NewToken that the orchestrator passes through
 * `TokenService.findOrCreateByIdentity` to materialize a real `Token`
 * row before persisting the holding.
 */
export interface HoldingSnapshot {
  /** Provider-native asset id ('BTC', 'XXBT', 'ETH', etc.) — feeds
      the dedup constraint on holdings.externalId. */
  externalId: string;
  tokenIdentity: Partial<NewToken>;
  /** Decimal.js string. */
  balance: string;
  /**
   * When the SOURCE says this balance was true — not when we asked it.
   *
   * For a live-balance API the two are the same instant and `new Date()` is
   * the honest answer. For a reporting interface they are not: IBKR's Flex
   * activity statement is generated after the close, so a statement fetched
   * at 15:10Z can carry positions as of the previous business day, and every
   * row in it says so in its own `reportDate` attribute (SC-384).
   *
   * A provider that is handed an as-of date MUST pass it through rather than
   * stamp the clock over it. Substituting our clock is what made a correct
   * IBKR sync read as a wrong number: the balance was right for the day it
   * described, and the screen said it described now.
   */
  capturedAt: Date;
  /**
   * Why `capturedAt` trails the fetch — one sentence, in the reader's words,
   * set only by a provider whose lag is STRUCTURAL rather than incidental.
   *
   * `ctx.noteWarning`'s voice (SC-428) on the balance side: it explains and
   * it retracts nothing. A date alone tells a reader their data is old
   * without telling them it is also correct and expected, which is the half
   * that stops them concluding the integration is broken.
   *
   * Absent on every provider that answers with live balances — there is
   * nothing to explain, and a note on all of them would teach the eye to
   * skip the place the real one appears.
   */
  asOfNote?: string;
  /**
   * Token type code — `'crypto'` (default), `'fiat'`, `'stock'`. The
   * orchestrator uses this to pick the correct `tokenTypes` row when
   * creating the underlying `Token` (and to route the holding to the
   * right pricer downstream — fiat goes to Frankfurter, crypto to
   * CoinGecko/DeFiLlama, stock to Finnhub/Yahoo). Providers that mix
   * fiat + crypto in one balance call (Kraken, Coinbase, IBKR) must
   * set this explicitly; pure-crypto providers can omit it.
   */
  tokenType?: string;
}

/**
 * A position the account TRADED and no longer holds (SC-398).
 *
 * Identified exactly the way a `HoldingSnapshot` identifies the same asset, so
 * the two are comparable: an `externalId` in both is a position still open, one
 * only here is a position that was closed.
 *
 * IT CARRIES NO BALANCE BECAUSE THE BALANCE IS ZERO, MEASURED. The producer
 * reads it rather than inferring it from the asset's absence from
 * `fetchBalances` — those two calls can see different populations, and the
 * caller anchors a holding on this. A field that is always `'0'` would say
 * less than the type's own name does.
 */
export interface ExitedPosition {
  /** Same key `fetchBalances` emits for the same asset — `'native'`, a
      contract address, a mint. That is what makes the two comparable. */
  externalId: string;
  tokenIdentity: Partial<NewToken>;
  /** Token type code, as on `HoldingSnapshot`. */
  tokenType?: string;
}

/**
 * What a direct balance question about ONE already-known asset came back with
 * (SC-852).
 *
 * `fetchBalances` answers by DISCOVERY and omits anything at zero, so a token
 * that left the wallet and a token the discovery failed to reach are the same
 * absence. Every layer above inherits that ambiguity: the refresh tells the
 * user "USDC wasn't returned — try again in a minute", which is right for one
 * cause and impossible for the other, because a departed token will never be
 * non-zero again.
 *
 * The three states are the whole point of the type. Collapsing `unreadable`
 * into `exited` anchors a holding at a zero nobody read; collapsing it into
 * `held` re-creates the bug. A producer that cannot tell them apart must say
 * `unreadable`.
 */
export interface PositionProbe {
  /** The key that was asked about — same one `fetchBalances` emits. */
  externalId: string;
  /**
   * `exited`     — the balance was READ and is zero. This is the claim a
   *                caller may anchor a holding on.
   * `held`       — read, and non-zero. The asset is still there and discovery
   *                simply missed it, which is the blind spot `staleStrategy:
   *                'preserve'` exists for.
   * `unreadable` — the question could not be answered. Says nothing about the
   *                balance.
   */
  state: 'exited' | 'held' | 'unreadable';
}

/**
 * Sub-account discovered under a single integration credential. Brokers
 * (IBKR Flex Query) and venues (Wise multi-currency, Binance spot vs
 * margin) expose multiple accounts behind one set of credentials; the
 * `AccountDiscoveryProvider` capability returns this shape so use
 * cases like `ImportExchangeAccountsUseCase` can iterate.
 */
export interface DiscoveredAccount {
  /** Provider-native id — feeds accounts.externalId for dedup. */
  externalId: string;
  /** Human-readable label for the UI. */
  label: string;
  /** Native fiat / settlement currency, when applicable. */
  nativeCurrency?: string;
  /** Open-ended provider details (sub-account type, market segment,
      etc.). Persisted into accounts.metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Single ledger event from a transactions ingester. Mirrors the shape
 * we persist in `holding_transactions`, but expressed in terms of
 * partial token identities — so the orchestrator can find-or-create
 * the relevant tokens through the same federation flow that handles
 * brand-new wallet imports. `kind` matches the holding_transactions
 * schema enum.
 */
export interface TransactionEvent {
  /** Stable provider-native id (chain tx hash, exchange trade id,
      etc.) — feeds the (holding_id, source, external_id) unique. */
  externalId: string;
  occurredAt: Date;
  kind:
    | 'buy'
    | 'sell'
    | 'deposit'
    | 'withdraw'
    | 'fee'
    | 'reward'
    | 'interest'
    | 'transfer_in'
    | 'transfer_out'
    | 'swap_in'
    | 'swap_out'
    | 'opening_balance'
    | 'unknown';
  /** Primary token + signed quantity. Outflows negative; inflows
      positive. Sign-enforcement happens at the base-class boundary,
      not in concrete providers. `tokenType` ('crypto' | 'fiat' |
      'stock' | …) hints the orchestrator at the right `tokenTypes`
      row when it has to find-or-create the underlying `Token`.
      Mixed-asset providers (IBKR equity vs cash, Kraken USD vs BTC)
      MUST set this; pure-crypto providers can omit it. */
  primary: { tokenIdentity: Partial<NewToken>; quantity: string; tokenType?: string };
  /** Other side of a trade or swap. Optional. */
  counter?: { tokenIdentity: Partial<NewToken>; quantity: string; tokenType?: string };
  /** Fee leg, in its own native token (often distinct from primary). */
  fee?: { tokenIdentity: Partial<NewToken>; quantity: string; tokenType?: string };
  /** Normalised payee/payer, when the source knows one. */
  counterparty?: string;
  /** Free-text statement line, when the source provides one. */
  description?: string;
  /** Per-unit price at the time the tx happened, denominated in its
      native quote currency (a Kraken BTC/EUR trade has
      `quoteIdentity` = EUR). Stored as-is so cost basis stays
      currency-correct without round-tripping through USD. */
  priceNative?: { value: string; quoteIdentity: Partial<NewToken>; tokenType?: string };
  /**
   * Provider-native key shared by the legs of one swap — an on-chain
   * `<chainId>:<txHash>`, an exchange conversion id. It is NOT the
   * `holding_transactions.swap_group_id` uuid: the orchestrator mints
   * that, and only for a key whose legs all survive holding resolution.
   * A provider says "these belong together"; whether they both made it
   * into the ledger is not a question a provider can answer (SC-332).
   */
  swapGroupKey?: string;
  rawPayload?: unknown;
}
