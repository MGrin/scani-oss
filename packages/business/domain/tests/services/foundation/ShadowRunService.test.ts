import { describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { Container } from 'typedi';
import { BalanceShadowService } from '../../../src/services/foundation/BalanceShadowService';
import {
  ShadowRunService,
  type ShadowTally,
} from '../../../src/services/foundation/ShadowRunService';
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
  test('a balance run writes its summary byte for byte as before any kind could add to it', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      await storedAboveItsEvidence(tx, user.id);

      const { runId, summary } = await Container.get(BalanceShadowService).run(
        { asOf: AS_OF, pastInstants: [at('2026-02-15T00:00:00Z')], userId: user.id },
        tx
      );

      // Not vacuous: the run found a difference a summary could have counted by instant.
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

  test("a kind's summarize adds its keys to the summary, stored with the run", async () => {
    await withTestDb(async (tx) => {
      const difference: ShadowTally['differences'][number] = {
        comparator: 'price-graph',
        category: 'unexplained',
        at: AS_OF,
        engineValue: '1',
        legacyValue: '2',
        detail: {},
        userId: null,
        holdingId: null,
        tokenId: null,
        baseTokenId: null,
      };

      const { runId, summary } = await Container.get(ShadowRunService).run(
        {
          kind: 'price',
          asOf: AS_OF,
          userId: undefined,
          units: async () => ['one'],
          describe: (unit) => unit,
          compare: async () => ({ compared: 2, differences: [difference] }),
          summarize: (differences) => ({
            byInstant: { [AS_OF.toISOString()]: { unexplained: differences.length } },
            valueImpactByBase: {},
          }),
        },
        tx
      );

      expect(Object.keys(summary)).toEqual([
        'compared',
        'matched',
        'byCategory',
        'byInstant',
        'valueImpactByBase',
        'durationMs',
      ]);
      expect(summary).toMatchObject({
        compared: 2,
        matched: 1,
        byInstant: { [AS_OF.toISOString()]: { unexplained: 1 } },
        valueImpactByBase: {},
      });
      expect((await runRow(tx, runId)).summary).toEqual(summary);
    });
  });
});
