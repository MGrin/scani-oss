import type { DatabaseTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import type { HoldingTransaction } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import Decimal from 'decimal.js';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { Service } from 'typedi';
import {
  MANUAL_EDIT_CORRECTION_SOURCE,
  MANUAL_EDIT_FLOW_SOURCE,
  PERSON_AUTHORED_SOURCES,
} from '../../lib/person-authored-sources';
import {
  findSupersededEdits,
  type ImportedCandidate,
  type ManualEditCandidate,
  type RowAnswer,
} from '../../lib/transactions/manual-edit-supersession';

export interface SupersessionOutcome {
  readonly removedEditRowIds: readonly string[];
  readonly keptForReview: readonly string[];
}

/**
 * Removes a hand-entered balance edit once imported rows describe the same
 * movement (SC-1468).
 *
 * A person reconciling Airwallex by hand typed the NET of a deposit and its
 * fee a day before the importer wrote both legs, so the account counted the
 * money twice. The importer's own adoption only folds a transfer-review row
 * into ONE imported row of the same amount; it cannot see an edit equal to a
 * SUM of rows. This does, through `findSupersededEdits`.
 *
 * An owner's answer is never discarded silently. An edit whose answer created
 * counterpart legs (a declared transfer or a split) is left alone outright:
 * removing it would strand those legs, and that undo belongs to the review
 * path, not to an import. Any other answered edit goes only when the imported
 * row says the same thing; otherwise it stays, and stays in Review.
 */
@Service()
export class ManualEditSupersessionService {
  private readonly logger = createComponentLogger('service:ManualEditSupersession');

  async supersede(
    userId: string,
    holdingIds: readonly string[],
    transaction?: DatabaseTransaction
  ): Promise<SupersessionOutcome> {
    const executor = transaction ?? db;
    if (holdingIds.length === 0) return { removedEditRowIds: [], keptForReview: [] };

    const rows = await executor
      .select()
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, userId),
          inArray(schema.holdingTransactions.holdingId, [...holdingIds]),
          notInArray(schema.holdingTransactions.source, [MANUAL_EDIT_CORRECTION_SOURCE])
        )
      );

    const removed: string[] = [];
    const kept: string[] = [];
    for (const holdingId of holdingIds) {
      const mine = rows.filter((row) => row.holdingId === holdingId);
      const edits = manualEditCandidates(mine);
      if (edits.length === 0) continue;
      const imported = mine
        .filter((row) => !(PERSON_AUTHORED_SOURCES as readonly string[]).includes(row.source))
        .map(importedCandidate);

      for (const verdict of findSupersededEdits(edits, imported)) {
        if (verdict.status === 'supersede') removed.push(...verdict.edit.rowIds);
        else kept.push(verdict.edit.flowId);
      }
    }

    if (removed.length > 0) {
      await executor
        .delete(schema.holdingTransactions)
        .where(
          and(
            eq(schema.holdingTransactions.userId, userId),
            inArray(schema.holdingTransactions.id, removed)
          )
        );
    }
    if (removed.length > 0 || kept.length > 0) {
      this.logger.info(
        { userId, removedEditRows: removed.length, keptForReview: kept },
        'Hand-entered balance edits checked against imported rows'
      );
    }
    return { removedEditRowIds: removed, keptForReview: kept };
  }
}

function manualEditCandidates(rows: readonly HoldingTransaction[]): ManualEditCandidate[] {
  const flows = rows.filter(
    (row) => row.source === MANUAL_EDIT_FLOW_SOURCE && !feeForExternalId(row)
  );
  const candidates: ManualEditCandidate[] = [];
  for (const flow of flows) {
    // An answer that wrote counterpart legs is not this service's to undo.
    if (flow.transferGroupId || flow.transferReviewSplit) continue;
    const fees = rows.filter(
      (row) => row.source === MANUAL_EDIT_FLOW_SOURCE && feeForExternalId(row) === flow.externalId
    );
    const editedAt = editedAtOf(flow);
    if (!editedAt) continue;
    candidates.push({
      flowId: flow.id,
      rowIds: [flow.id, ...fees.map((fee) => fee.id)],
      amount: fees.reduce((sum, fee) => sum.add(fee.quantity), new Decimal(flow.quantity)),
      occurredAt: flow.occurredAt,
      editedAt,
      answer: answerOf(flow),
    });
  }
  return candidates;
}

function importedCandidate(row: HoldingTransaction): ImportedCandidate {
  return {
    id: row.id,
    quantity: new Decimal(row.quantity),
    occurredAt: row.occurredAt,
    answer: answerOf(row),
  };
}

function answerOf(row: HoldingTransaction): RowAnswer | null {
  if (!row.transferReview) return null;
  // A leg-writing answer never equals a plain one; its destination is the
  // group or split itself, so an unanswered-legs edit cannot match it.
  const destination = row.transferGroupId
    ? `group:${row.transferGroupId}`
    : row.transferReviewSplit
      ? `split:${JSON.stringify(row.transferReviewSplit)}`
      : null;
  return { kind: row.transferReview, destination };
}

function metadata(row: HoldingTransaction): Record<string, unknown> {
  return (row.sourceMetadata ?? {}) as Record<string, unknown>;
}

function feeForExternalId(row: HoldingTransaction): string | null {
  const value = metadata(row).feeForExternalId;
  return typeof value === 'string' ? value : null;
}

function editedAtOf(row: HoldingTransaction): Date | null {
  const value = metadata(row).editedAt;
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
