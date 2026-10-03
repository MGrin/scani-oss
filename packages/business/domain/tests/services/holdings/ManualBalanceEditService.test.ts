/**
 * `ManualBalanceEditService` — what a manual balance edit writes to the
 * ledger, and what it deliberately does not (SC-510).
 *
 * Against a real database rather than stubs, because the assertions that
 * matter are about how the row lands beside the rest of the ledger: that a
 * correction is dated one millisecond after the observation it supersedes,
 * and that a replayed edit collapses onto its own row through the real
 * `(holding, source, external_id)` unique constraint. A stubbed repository
 * would assert the arguments we passed rather than what the database did with
 * them, and both of those facts are the database's.
 *
 * `resolveCause` is pure and needs none of that, so its tests do not open a
 * transaction.
 */

import { describe, expect, test } from 'bun:test';
import * as schema from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import { asc, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { ManualBalanceEditService } from '../../../src/services/holdings/ManualBalanceEditService';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';

const service = () => Container.get(ManualBalanceEditService);

type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];

async function scaffold(tx: Tx, balance = '1000') {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const token = await makeToken(tx);
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    balance,
    source: 'manual',
  });
  return { user, account, token, holding };
}

function ledgerFor(tx: Tx, holdingId: string) {
  return tx
    .select()
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.holdingId, holdingId))
    .orderBy(asc(schema.holdingTransactions.occurredAt));
}

describe('ManualBalanceEditService.resolveCause', () => {
  test('a holding whose price we fetch resolves to a flow with nobody asked', () => {
    expect(service().resolveCause({ tokenTypeCode: 'stock' })).toBe('flow');
    expect(service().resolveCause({ tokenTypeCode: 'crypto' })).toBe('flow');
  });

  test('an ambiguous holding nobody has answered for REFUSES rather than defaulting', () => {
    expect(service().resolveCause({ tokenTypeCode: 'fiat' })).toBeNull();
    expect(service().resolveCause({ tokenTypeCode: 'fiat', remembered: null })).toBeNull();
    expect(service().resolveCause({ tokenTypeCode: 'private-company' })).toBeNull();
  });

  test("the holding's remembered answer stands in for the question", () => {
    expect(service().resolveCause({ tokenTypeCode: 'fiat', remembered: 'growth' })).toBe('growth');
  });

  test('a remembered value that is not a cause is not one', () => {
    // The column is plain text with no CHECK — a stray value must fall back to
    // asking, not be passed through as a fourth cause nothing handles.
    expect(service().resolveCause({ tokenTypeCode: 'fiat', remembered: 'deposit' })).toBeNull();
  });

  test('what the user said wins, even where a cause could have been derived', () => {
    // A mistyped share count on a priced holding is a restatement. That we
    // COULD have derived `flow` is not a reason to overrule a person who told
    // us otherwise.
    expect(service().resolveCause({ tokenTypeCode: 'stock', requested: 'correction' })).toBe(
      'correction'
    );
  });

  /**
   * The conservative fallback, and the one worth keeping when somebody
   * simplifies this. `findWithType` left-joins `token_types`, so a null code
   * is reachable. "Could not find out" must resolve toward asking — resolving
   * it toward `flow` would make a broken join silently classify every edit it
   * touched.
   */
  test('a token type we could not read asks rather than assuming it is priced', () => {
    expect(service().resolveCause({ tokenTypeCode: null })).toBeNull();
  });
});

describe('ManualBalanceEditService.record', () => {
  test('money added to a manual holding is a deposit at the date the user gave', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await scaffold(tx, '1000');
      const moved = new Date('2026-06-15T00:00:00Z');

      await service().record(
        {
          holding,
          previousBalance: '1000',
          newBalance: '6000',
          cause: 'flow',
          occurredAt: moved,
          editedAt: new Date('2026-08-21T10:00:00Z'),
        },
        tx
      );

      const rows = await ledgerFor(tx, holding.id);
      expect(rows.length).toBe(1);
      expect(rows[0]!.kind).toBe('deposit');
      expect(rows[0]!.quantity).toBe('5000');
      // The date the money moved, NOT the date it was typed in. Dating it at
      // the edit is what concentrates months of flow onto one day.
      expect(rows[0]!.occurredAt.toISOString()).toBe(moved.toISOString());
    });
  });

  // D-6: any write lowers the holding's start, never raises it (R86).
  test('a flow dated before the holding’s start moves the start back to it, and a later one leaves it', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await scaffold(tx, '1000');
      const unstarted = await makeHolding(tx, {
        userId: holding.userId,
        accountId: holding.accountId,
        tokenId: (await makeToken(tx)).id,
        balance: '1000',
      });
      await tx
        .update(schema.holdings)
        .set({ startsAt: new Date('2026-08-01T00:00:00Z') })
        .where(eq(schema.holdings.id, holding.id));
      const movedAt = new Date('2026-06-15T00:00:00Z');
      const flow = (
        on: { id: string; userId: string; tokenId: string; lastUpdated: Date },
        newBalance: string,
        occurredAt: Date,
        editedAt: string
      ) =>
        service().record(
          {
            holding: on,
            previousBalance: '1000',
            newBalance,
            cause: 'flow',
            occurredAt,
            editedAt: new Date(editedAt),
          },
          tx
        );
      const startOf = async (holdingId: string) =>
        (
          await tx
            .select({ startsAt: schema.holdings.startsAt })
            .from(schema.holdings)
            .where(eq(schema.holdings.id, holdingId))
        )[0]?.startsAt;

      await flow(holding, '6000', movedAt, '2026-08-21T10:00:00Z');
      expect(await startOf(holding.id)).toEqual(movedAt);

      await flow(holding, '1500', new Date('2026-07-01T00:00:00Z'), '2026-08-22T10:00:00Z');
      expect(await startOf(holding.id)).toEqual(movedAt);

      // A NULL start stays NULL, for the classification backfill to derive.
      await flow(unstarted, '6000', movedAt, '2026-08-21T10:00:00Z');
      expect(await startOf(unstarted.id)).toBeNull();
    });
  });

  test('money removed is a withdraw carrying a negative quantity', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await scaffold(tx, '1000');

      await service().record(
        {
          holding,
          previousBalance: '1000',
          newBalance: '250',
          cause: 'flow',
          occurredAt: new Date('2026-07-01T00:00:00Z'),
          editedAt: new Date('2026-08-21T10:00:00Z'),
        },
        tx
      );

      const rows = await ledgerFor(tx, holding.id);
      expect(rows[0]!.kind).toBe('withdraw');
      expect(rows[0]!.quantity).toBe('-750');
    });
  });

  // A2 D-1 exception U4 (R100 m4): the rows of a dust movement state their
  // quantities as plain decimals, as the balance beside them is written.
  test('a dust movement writes its quantity and its fee in plain notation', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await scaffold(tx, '0.0000002');

      await service().record(
        {
          holding,
          previousBalance: '0.0000002',
          newBalance: '0',
          cause: 'flow',
          occurredAt: new Date('2026-07-01T00:00:00Z'),
          editedAt: new Date('2026-08-21T10:00:00Z'),
          fee: new Decimal('0.00000005'),
        },
        tx
      );

      const rows = await ledgerFor(tx, holding.id);
      expect(rows.map((row) => [row.kind, row.quantity]).sort()).toEqual([
        ['fee', '-0.00000005'],
        ['withdraw', '-0.00000015'],
      ]);
      // The control: these are the values `Decimal` computes, in the text it
      // gives them itself. Only the text differs.
      expect([
        new Decimal('-0.00000005').toString(),
        new Decimal('-0.00000015').toString(),
      ]).toEqual(['-5e-8', '-1.5e-7']);
    });
  });

  /**
   * **The branch a future reader will want to "fix", so the reason is here.**
   *
   * It looks like an omission: every other cause writes a row, this one
   * writes nothing, and `interest` is right there in the kind vocabulary.
   *
   * Writing an `interest` row would not be neutral. Growth on a hand-tracked
   * balance is already counted as performance — the value series is
   * reconstructed from observations and `BalanceAtTimeService.driftAhead`
   * spreads the unexplained rise across the gap between the two observations
   * that bracket it, returning `interpolated: true` so every consumer knows
   * the shape was inferred. An `interest` row would replace that with a step
   * on whatever date we picked, which is invented data too and does NOT
   * declare itself.
   *
   * So: no row, and the answer is remembered on the holding instead.
   */
  test('growth writes nothing to the ledger, on purpose', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await scaffold(tx, '1000');

      const result = await service().record(
        {
          holding,
          previousBalance: '1000',
          newBalance: '1042.50',
          cause: 'growth',
          occurredAt: new Date('2026-08-21T10:00:00Z'),
          editedAt: new Date('2026-08-21T10:00:00Z'),
        },
        tx
      );

      expect(result.skipped).toBe('growth-needs-no-row');
      expect(await ledgerFor(tx, holding.id)).toEqual([]);
    });
  });

  test('a correction is dated where the wrong figure entered the record, not where it was noticed', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx, '1000');
      const wrongFigureRecordedAt = new Date('2026-05-01T09:00:00Z');
      await tx.insert(schema.holdingBalanceObservations).values({
        userId: user.id,
        holdingId: holding.id,
        balance: '1000',
        observedAt: wrongFigureRecordedAt,
        source: 'sync-capture',
      });

      const noticedAt = new Date('2026-08-21T10:00:00Z');
      await service().record(
        {
          holding,
          previousBalance: '1000',
          newBalance: '1200',
          cause: 'correction',
          // Deliberately supplied and deliberately ignored: a correction is
          // not dated by the person fixing it.
          occurredAt: noticedAt,
          editedAt: noticedAt,
        },
        tx
      );

      const rows = await ledgerFor(tx, holding.id);
      expect(rows.length).toBe(1);
      expect(rows[0]!.kind).toBe('correction');
      expect(rows[0]!.quantity).toBe('200');
      // One millisecond after the observation it supersedes, so the anchor
      // walk covers it for every later date and the restated interval starts
      // exactly where the wrong figure did.
      expect(rows[0]!.occurredAt.getTime()).toBe(wrongFigureRecordedAt.getTime() + 1);
      expect(rows[0]!.occurredAt.getTime()).toBeLessThan(noticedAt.getTime());
    });
  });

  test('a correction on a never-observed holding falls back to when the row was last written', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await scaffold(tx, '1000');

      await service().record(
        {
          holding,
          previousBalance: '1000',
          newBalance: '900',
          cause: 'correction',
          occurredAt: new Date('2026-08-21T10:00:00Z'),
          editedAt: new Date('2026-08-21T10:00:00Z'),
        },
        tx
      );

      const rows = await ledgerFor(tx, holding.id);
      expect(rows[0]!.occurredAt.getTime()).toBe(holding.lastUpdated.getTime() + 1);
    });
  });

  test('an edit that moves nothing writes nothing', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await scaffold(tx, '1000');

      const result = await service().record(
        {
          holding,
          previousBalance: '1000',
          newBalance: '1000.0',
          cause: 'flow',
          occurredAt: new Date('2026-08-21T10:00:00Z'),
          editedAt: new Date('2026-08-21T10:00:00Z'),
        },
        tx
      );

      expect(result.skipped).toBe('no-delta');
      expect(await ledgerFor(tx, holding.id)).toEqual([]);
    });
  });

  test('the same edit replayed collapses onto one row', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await scaffold(tx, '1000');
      const input = {
        holding,
        previousBalance: '1000',
        newBalance: '1500',
        cause: 'flow' as const,
        occurredAt: new Date('2026-06-15T00:00:00Z'),
        editedAt: new Date('2026-08-21T10:00:00Z'),
      };

      await service().record(input, tx);
      await service().record(input, tx);

      // The dedup key is (holding, source, external_id) and the external id is
      // the edit instant — a retried mutation is one deposit, not two.
      expect((await ledgerFor(tx, holding.id)).length).toBe(1);
    });
  });

  test('two different edits are two rows even on the same day', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await scaffold(tx, '1000');
      const moved = new Date('2026-06-15T00:00:00Z');

      await service().record(
        {
          holding,
          previousBalance: '1000',
          newBalance: '1500',
          cause: 'flow',
          occurredAt: moved,
          editedAt: new Date('2026-08-21T10:00:00Z'),
        },
        tx
      );
      await service().record(
        {
          holding,
          previousBalance: '1500',
          newBalance: '1900',
          cause: 'flow',
          occurredAt: moved,
          editedAt: new Date('2026-08-21T10:05:00Z'),
        },
        tx
      );

      const rows = await ledgerFor(tx, holding.id);
      expect(rows.length).toBe(2);
      expect(rows.map((r) => r.quantity).sort()).toEqual(['400', '500']);
    });
  });
});
