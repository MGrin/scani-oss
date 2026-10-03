import type { StatementIngesterResult, StatementRow } from '@scani/ingesters';
import {
  BALANCE_COPY_ORIGIN,
  FILE_IMPORT_LEGACY_ANCHOR,
  LEGACY_ANCHOR_KEY,
  SYNC_CAPTURE_SOURCE,
} from '../../foundation/legacy-ledger-kinds';
import { STATEMENT_INPUT_SOURCE } from '../../foundation/plan-feed-inputs';
import { declareWindow } from '../blocks/window-declarer';
import type { AssetRef, FeedBatch, FeedEntry, LegacyEntryColumns } from '../feed-batch';

/** A statement names a currency and nothing else, so the catalog decides the token (D-2). */
function currencyAsset(currency: string): AssetRef {
  return {
    identity: { symbol: currency, name: currency },
    typeCode: 'fiat',
    lookup: 'catalog-symbol',
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
 * the upload creates, to the sum of its rows, and the balance copy beside each
 * cache write (rulings R19, R21).
 *
 * The window is what the file covered, so every parsed row bounds it, the ones
 * it could not import included (ruling R25).
 *
 * `fetchedAt` has to be the same for the same file, because it is what keeps a
 * second upload of it from recording a second window. Throws when the
 * statement has no row to bound a window with.
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
      rowDates: result.lines.flatMap((line) =>
        'skipped' in line ? [line.at] : line.rows.map((row) => row.occurredAt)
      ),
      uploadRef: input.uploadRef,
    }),
    checkpoints: result.closes.map((close) => ({
      asset: currencyAsset(close.currency),
      at: close.at,
      amount: close.balance,
      authority: 'statement',
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
      cacheObservation: {
        source: SYNC_CAPTURE_SOURCE,
        meta: { origin: BALANCE_COPY_ORIGIN, [LEGACY_ANCHOR_KEY]: FILE_IMPORT_LEGACY_ANCHOR },
      },
      derivesTradeLegs: false,
      holdingFailure: 'fail-batch',
    },
    notices: [],
  };
}
