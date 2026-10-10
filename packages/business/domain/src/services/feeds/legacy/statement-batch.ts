import type { StatementIngesterResult, StatementRow } from '@scani/ingesters';
import { STATEMENT_INPUT_SOURCE } from '../../foundation/plan-feed-inputs';
import { declareWindow } from '../blocks/window-declarer';
import type { AssetRef, FeedBatch, FeedEntry, LegacyEntryColumns } from '../feed-batch';

/** A statement names a currency and nothing else, so the catalog decides the token (D-2). */
export function currencyAsset(currency: string): AssetRef {
  return {
    identity: { symbol: currency, name: currency },
    typeCode: 'fiat',
    lookup: 'catalog-symbol',
  };
}

function securityAsset(symbol: string): AssetRef {
  return {
    identity: { symbol, name: symbol },
    typeCode: 'stock',
    lookup: 'catalog-symbol-of-type',
  };
}

function entryOf(asset: AssetRef, row: StatementRow): FeedEntry {
  const legacy: LegacyEntryColumns = {
    kind: row.kind,
    source: row.source,
    sourceMetadata: row.sourceMetadata,
    rawPayload: row.rawPayload,
  };
  return {
    externalId: row.externalId,
    asset,
    amount: row.quantity,
    occurredAt: row.occurredAt,
    ...(row.counterparty === null ? {} : { counterparty: row.counterparty }),
    legacy,
  };
}

/**
 * One uploaded statement as a feed batch, writing what the file import wrote
 * before it moved (D-1): rows into the account's holding of each currency, the
 * close as a statement checkpoint, the cache set to the close or, for a holding
 * the upload creates, to the sum of its rows. The balance copy it wrote beside
 * each cache write (rulings R19, R21) stopped in A5 (D-19): the engine reads the close.
 *
 * A positions statement (IB) is the exception: its holdings at the period end
 * become statement checkpoints, securities found by ticker within their type.
 *
 * The window is what the file covered, so every parsed row bounds it, the ones
 * it could not import included (ruling R25), and so does a positions date.
 *
 * `fetchedAt` has to be the same for the same file, because it is what keeps a
 * second upload of it from recording a second window. Throws when the
 * statement has no row and no position to bound a window with.
 */
export function legacyStatementBatch(input: {
  userId: string;
  accountId: string;
  result: StatementIngesterResult;
  uploadRef: string;
  fetchedAt: Date;
}): FeedBatch {
  const { result } = input;
  const entries = result.lines.flatMap((line) =>
    'skipped' in line ? [] : line.rows.map((row) => entryOf(currencyAsset(line.currency), row))
  );
  return {
    userId: input.userId,
    input: {
      accountId: input.accountId,
      source: STATEMENT_INPUT_SOURCE,
      credentialId: null,
      walletId: null,
    },
    fetchedAt: input.fetchedAt,
    window: declareWindow({
      shape: 'statement-upload',
      rowDates: [
        ...result.lines.flatMap((line) =>
          'skipped' in line ? [line.at] : line.rows.map((row) => row.occurredAt)
        ),
        ...result.positions.map((position) => position.at),
        ...result.closes.map((close) => close.at),
      ],
      uploadRef: input.uploadRef,
    }),
    checkpoints: [
      ...result.closes.map((close) => ({
        asset: currencyAsset(close.currency),
        at: close.at,
        amount: close.balance,
      })),
      // An exception to D-1, by the feeds owner's ruling on SC-1529: the file
      // import before the move wrote nothing for a positions statement, so
      // these checkpoints set figures today's path never set.
      ...result.positions.map((position) => ({
        asset: securityAsset(position.symbol),
        at: position.at,
        amount: position.quantity,
      })),
    ].map((checkpoint) => ({
      ...checkpoint,
      authority: 'statement' as const,
      legacySource: 'statement-close',
      legacyMeta: { format: result.format, bankTemplate: result.bankTemplate },
    })),
    entries,
    absences: [],
    legacy: {
      holdingMatch: 'account-token',
      holdingPolicy: 'create',
      holdingSource: 'statement-import',
      arrival: 'user_confirmed',
      writesCache: true,
      createdWithoutCheckpoint: 'sum-of-entries',
      derivesTradeLegs: false,
      holdingFailure: 'fail-batch',
      absence: null,
      clearsAbsenceTally: false,
      createdCheckpointMeta: null,
      unchangedCheckpoint: 'append',
      zeroOpensHolding: true,
    },
    notices: [],
  };
}
