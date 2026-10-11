import { createHash } from 'node:crypto';
import type { BudgetAppRow } from '@scani/file-import';
import { Decimal } from '@scani/shared';
import { type BudgetApp, budgetAppSource } from '../../foundation/plan-feed-inputs';
import { declareWindow } from '../blocks/window-declarer';
import type { FeedBatch, FeedEntry } from '../feed-batch';
import { currencyAsset } from '../legacy/statement-batch';

/**
 * Stable across uploads: the same row in an overlapping file keeps its id, so
 * it updates rather than duplicates. Identical rows on one day are told apart
 * by their order in the file, which a later export keeps.
 */
function externalIds(app: BudgetApp, rows: readonly BudgetAppRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const day = row.date.toISOString().slice(0, 10);
    const text = createHash('sha256')
      .update(`${row.payee ?? ''}\u0000${row.memo ?? ''}`, 'utf8')
      .digest('hex')
      .slice(0, 16);
    const key = `${app}:${day}:${row.amount}:${text}`;
    const ordinal = (seen.get(key) ?? 0) + 1;
    seen.set(key, ordinal);
    return `${key}:${ordinal}`;
  });
}

/**
 * One account of a budget app's register as a feed batch (SC-1649). The file
 * carries no balance, so there is no checkpoint and a holding the batch
 * creates holds the sum of its rows. Category, cleared and flag have no home
 * in scani yet and ride in `source_metadata` (ruling Q5).
 */
export function budgetAppBatch(input: {
  userId: string;
  accountId: string;
  app: BudgetApp;
  currency: string;
  rows: readonly BudgetAppRow[];
  uploadRef: string;
  fetchedAt: Date;
}): FeedBatch {
  const source = budgetAppSource(input.app);
  const asset = currencyAsset(input.currency);
  const ids = externalIds(input.app, input.rows);
  const entries: FeedEntry[] = input.rows.map((row, i) => {
    const counterparty = row.transferAccount ?? row.payee;
    return {
      externalId: ids[i]!,
      asset,
      amount: row.amount,
      occurredAt: row.date,
      ...(counterparty === null ? {} : { counterparty }),
      ...(row.memo === null ? {} : { description: row.memo }),
      legacy: {
        kind: new Decimal(row.amount).isNegative() ? 'withdraw' : 'deposit',
        source,
        sourceMetadata: {
          app: input.app,
          payee: row.payee,
          category: row.category,
          cleared: row.cleared,
          flag: row.flag,
          transferAccount: row.transferAccount,
          line: row.line,
        },
        rawPayload: null,
      },
    };
  });
  return {
    userId: input.userId,
    input: { accountId: input.accountId, source, credentialId: null, walletId: null },
    fetchedAt: input.fetchedAt,
    window: declareWindow({
      shape: 'statement-upload',
      rowDates: input.rows.map((row) => row.date),
      uploadRef: input.uploadRef,
    }),
    checkpoints: [],
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
