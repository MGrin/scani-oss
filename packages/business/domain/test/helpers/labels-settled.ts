import { expect } from 'bun:test';
import { Container } from 'typedi';
import { FoundationClassificationService } from '../../src/services/foundation/FoundationClassificationService';
import { STALE_LABEL_NOTE } from '../../src/services/foundation/legacy-classification';

/**
 * Asserts a writer left `userId`'s labels as the backfill would: nothing still
 * to fill and no label its row has moved away from. Reads committed rows only.
 *
 * `failedUsers` is asserted too, because a user whose classification threw
 * contributes zero to every count and would otherwise read as settled.
 */
export async function expectLabelsSettled(userId: string): Promise<void> {
  const report = await Container.get(FoundationClassificationService).classify({
    apply: false,
    userId,
  });
  expect({
    failedUsers: report.failedUsers,
    rowsUpdated: report.rowsUpdated,
    staleLabels: report.notes[STALE_LABEL_NOTE] ?? 0,
  }).toEqual({
    failedUsers: [],
    rowsUpdated: { holdings: 0, observations: 0, entries: 0 },
    staleLabels: 0,
  });
}
