import type { NewToken } from '@scani/db/schema';
import type { TransactionEvent } from '@scani/providers/core/types';
import { identityCacheKey } from '../../../lib/transactions/token-identity-key';
import { inputSourceClass } from '../../foundation/legacy-ledger-kinds';
import { declareWindow } from '../blocks/window-declarer';
import type {
  AssetRef,
  FeedBatch,
  FeedEntry,
  LegacyEntryColumns,
  TokenIdentity,
} from '../feed-batch';

/**
 * The token types a provider's `tokenType` hint can name: the codes the router
 * looked up. Any other hint, and none, creates a crypto token, as it did (IBKR
 * equities came out crypto before stocks declared theirs, 2026-05-06).
 */
const HINTED_TYPE_CODES: ReadonlySet<string> = new Set([
  'crypto',
  'fiat',
  'stock',
  'private-company',
  'other',
  'property',
  'vehicle',
]);

type Mention = { tokenIdentity: Partial<NewToken>; tokenType?: string };

/** Every token an event names, in the order the router resolved them. */
const mentionsOf = (event: TransactionEvent): Mention[] => [
  event.primary,
  ...(event.counter ? [event.counter] : []),
  ...(event.fee ? [event.fee] : []),
  ...(event.priceNative
    ? [{ tokenIdentity: event.priceNative.quoteIdentity, tokenType: event.priceNative.tokenType }]
    : []),
];

/**
 * The type each identity is looked up under. The router resolved an identity
 * once per run, by `identityCacheKey`, under the type its first mention hinted,
 * and every later mention reused that token whatever it hinted. The lookup
 * matches on the type, so each mention takes the first one's here.
 */
function typeCodes(events: readonly TransactionEvent[]): Map<string, string> {
  const codes = new Map<string, string>();
  for (const { tokenIdentity, tokenType } of events.flatMap(mentionsOf)) {
    const key = identityCacheKey(tokenIdentity);
    if (codes.has(key)) continue;
    codes.set(
      key,
      tokenType !== undefined && HINTED_TYPE_CODES.has(tokenType) ? tokenType : 'crypto'
    );
  }
  return codes;
}

function entryOf(
  source: string,
  event: TransactionEvent,
  typeOf: (identity: Partial<NewToken>) => string
): FeedEntry {
  const assetOf = (identity: Partial<NewToken>): AssetRef => ({
    identity: { ...identity, symbol: identity.symbol ?? '' } as TokenIdentity,
    typeCode: typeOf(identity),
    lookup: 'identity',
  });
  const legacy: LegacyEntryColumns = {
    kind: event.kind,
    source,
    sourceMetadata: event.sourceMetadata ?? {},
    rawPayload: (event.rawPayload as Record<string, unknown> | null) ?? null,
    priceNative: event.priceNative?.value ?? null,
    counterQuantity: event.counter?.quantity ?? null,
    feeQuantity: event.fee?.quantity ?? null,
  };
  return {
    externalId: event.externalId,
    asset: assetOf(event.primary.tokenIdentity),
    amount: event.primary.quantity,
    occurredAt: event.occurredAt,
    ...(event.swapGroupKey ? { groupKey: event.swapGroupKey } : {}),
    ...(event.counterparty == null ? {} : { counterparty: event.counterparty }),
    ...(event.description == null ? {} : { description: event.description }),
    legacyAssets: {
      ...(event.counter ? { counter: assetOf(event.counter.tokenIdentity) } : {}),
      ...(event.fee ? { fee: assetOf(event.fee.tokenIdentity) } : {}),
      ...(event.priceNative ? { priceQuote: assetOf(event.priceNative.quoteIdentity) } : {}),
    },
    legacy,
  };
}

/**
 * One transaction-import run as a feed batch, writing what the router and the
 * coordinator wrote before it moved (D-1): one row per event, on the holding
 * the import's own matching finds (a person's row as the fallback, D-4), its
 * swap legs paired under one group, and each trade's cash and own-fee legs,
 * which ingest derives once their tokens are known.
 *
 * A review-gated wallet finds only: an event whose token or holding the user
 * did not keep is skipped and counted (SC-343, D-13). The cache is not written:
 * a transaction import never wrote a balance.
 *
 * The window is what the fetch covered, so every event bounds it, the ones that
 * will not land included, and a run that read nothing records one too.
 */
export function legacyTransactionBatch(input: {
  userId: string;
  accountId: string;
  source: string;
  events: readonly TransactionEvent[];
  context: {
    since?: Date;
    until?: Date;
    fetchedAt: Date;
    historyStartsAt?: Date;
    horizonMs?: number;
    retracted: boolean;
  };
}): FeedBatch {
  const { source, events, context } = input;
  // Never after the fetch, so a provider's future-dated event cannot invert the window.
  const firstEventAt = events.reduce(
    (min, e) => (e.occurredAt < min ? e.occurredAt : min),
    context.fetchedAt
  );
  const codes = typeCodes(events);
  const typeOf = (identity: Partial<NewToken>) => codes.get(identityCacheKey(identity)) ?? 'crypto';
  return {
    userId: input.userId,
    input: { accountId: input.accountId, source, credentialId: null, walletId: null },
    fetchedAt: context.fetchedAt,
    window: declareWindow({ shape: 'transaction-run', ...context, firstEventAt }),
    checkpoints: [],
    entries: events.map((event) => entryOf(source, event, typeOf)),
    absences: [],
    legacy: {
      holdingMatch: 'ingest-order',
      holdingPolicy: inputSourceClass(source) === 'wallet' ? 'find-only' : 'create',
      holdingSource: 'ingest-backfill',
      arrival: null,
      writesCache: false,
      createdWithoutCheckpoint: 'zero',
      derivesTradeLegs: true,
      holdingFailure: 'skip-entry',
      absence: null,
      clearsAbsenceTally: false,
      createdCheckpointMeta: null,
      unchangedCheckpoint: 'append',
      zeroOpensHolding: true,
    },
    notices: [],
  };
}
