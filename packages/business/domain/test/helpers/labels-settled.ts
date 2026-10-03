import { expect } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { Container } from 'typedi';
import { EngineEvidenceRepository } from '../../src/repositories/EngineEvidenceRepository';
import { FoundationClassificationService } from '../../src/services/foundation/FoundationClassificationService';
import {
  classifyHoldingEvidence,
  STALE_LABEL_NOTE,
} from '../../src/services/foundation/legacy-classification';

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

/**
 * Asserts the role written on each of `userId`'s labelled person values is the
 * one the backfill derives for that row: the same read and classifier it runs
 * (`findHoldingEvidence`, `classifyHoldingEvidence`), over the same rows with
 * those roles erased. Erased, because Rule P never moves a persisted
 * `verification` back, so classifying the labelled rows agrees with any writer;
 * and `expectLabelsSettled` counts only NULLs, so it cannot see a wrong role
 * either (R84, R85). Reads in `tx` when given.
 */
export async function expectPersonRolesAsClassified(
  userId: string,
  tx?: DatabaseTransaction
): Promise<void> {
  const raws = await Container.get(EngineEvidenceRepository).findHoldingEvidence({ userId }, tx);
  const compared = raws.flatMap((raw) => {
    const written = raw.observations.filter((o) => o.authority === 'person' && o.role !== null);
    const derived = classifyHoldingEvidence({
      ...raw,
      observations: raw.observations.map((o) => (written.includes(o) ? { ...o, role: null } : o)),
    }).evidence.observations;
    return written.map((o) => ({
      id: o.id,
      written: o.role,
      derived: derived.find((d) => d.id === o.id)?.role ?? null,
    }));
  });
  // Something must have been compared, or every role would read as agreeing.
  expect(compared.length).toBeGreaterThan(0);
  expect(compared.map(({ id, derived }) => ({ id, role: derived }))).toEqual(
    compared.map(({ id, written }) => ({ id, role: written }))
  );
}
