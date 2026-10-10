import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { Container } from 'typedi';
import { BalanceShadowService } from '../../../src/services/foundation/BalanceShadowService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';
import { differencesOf, runRow } from '../../../test/helpers/shadow-runs';

const at = (iso: string) => new Date(iso);
const AS_OF = at('2026-03-01T00:00:00Z');

/** A manual holding stored as 60 that the person set to 50 on Feb 1: one difference at `AS_OF`. */
async function storedAboveItsEvidence(tx: DatabaseTransaction, userId: string): Promise<void> {
  const account = await makeAccount(tx, { userId, institutionId: (await makeInstitution(tx)).id });
  const holding = await makeHolding(tx, {
    userId,
    accountId: account.id,
    tokenId: (await makeToken(tx)).id,
    balance: '60',
    source: 'manual',
    createdAt: at('2026-01-01T00:00:00Z'),
  });
  await tx.insert(schema.holdingBalanceObservations).values({
    userId,
    holdingId: holding.id,
    balance: '50',
    observedAt: at('2026-02-01T00:00:00Z'),
    source: 'sync-capture',
    sourceMetadata: { origin: 'updateHolding' },
  });
}

describe('ShadowRunService.run', () => {
  test('a balance run writes exactly the summary it counts, byte for byte', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await storedAboveItsEvidence(tx, user.id);

      const { runId, summary } = await Container.get(BalanceShadowService).run(
        { asOf: AS_OF, userId: user.id },
        tx
      );

      // Not vacuous: the run found a difference to count.
      expect((await differencesOf(tx, runId)).length).toBeGreaterThan(0);
      const established = {
        compared: summary.compared,
        matched: summary.matched,
        byCategory: summary.byCategory,
        unlabelled: summary.unlabelled,
        excluded: summary.excluded,
        staleLabels: summary.staleLabels,
        durationMs: summary.durationMs,
      };
      expect(JSON.stringify(summary)).toBe(JSON.stringify(established));
      expect((await runRow(tx, runId)).summary).toEqual(established);
    });
  });
});
