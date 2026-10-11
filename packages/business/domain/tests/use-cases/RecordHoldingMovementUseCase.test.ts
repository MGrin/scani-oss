/**
 * `RecordHoldingMovementUseCase` — the movement the owner knows, instead of
 * the balance they had to compute (SC-607).
 *
 * ## What these tests are for, and it is not the balance
 *
 * The balance moving is the easy half and a test asserting only that would
 * pass against a version of this feature that generates exactly the review
 * prompt it exists to remove. The ticket's own measure is a COUNT — *record a
 * 2000 USD withdrawal from a manual cash holding and count the review
 * prompts, target zero* — so the central test counts rows matching
 * `pendingPredicate`, which is the transfer-review queue's own definition of
 * "still to be asked about", imported rather than restated.
 *
 * A must-be-FOUND control sits beside it: the same withdrawal written the way
 * the balance editor writes it — a `flow` edit with no answer — puts exactly
 * one row in that queue. Without that control, "0 prompts" is equally
 * consistent with a predicate that matches nothing, and every assertion here
 * would be vacuous.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { MANUAL_EDIT_FLOW_SOURCE } from '../../src/lib/person-authored-sources';
import { pendingPredicate } from '../../src/lib/transfer-review-queue';
import { FoundationClassificationService } from '../../src/services/foundation/FoundationClassificationService';
import { ManualEditFeeRefused } from '../../src/services/holdings/ManualBalanceEditService';
import {
  MovementExceedsBalanceError,
  MovementSameHoldingError,
  RecordHoldingMovementUseCase,
} from '../../src/use-cases/RecordHoldingMovementUseCase';
import { UpdateHoldingUseCase } from '../../src/use-cases/UpdateHoldingUseCase';
import { committedRows } from '../../test/helpers/committed-rows';
import { withTestDb } from '../../test/helpers/db';
import { seedHoldingCache } from '../../test/helpers/engine-guard';
import { makeCredential, makeInstitution, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeToken,
  makeWalletAccount,
  seedReading,
} from '../../test/helpers/factories-extra';
import { expectHistoryUnchanged, type HistoryReading } from '../../test/helpers/history-neutrality';
import {
  expectLabelsSettled,
  expectPersonRolesAsClassified,
} from '../../test/helpers/labels-settled';

const useCase = () => Container.get(RecordHoldingMovementUseCase);

type Tx = Parameters<Parameters<typeof withTestDb>[0]>[0];

/** A manual cash holding at 4,000 — a round balance, so an over-move is
 * obvious by a cent rather than by arithmetic. */
async function scaffold(tx: Tx) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const token = await makeToken(tx, { symbol: `USD${Date.now()}` });
  const holding = await makeHolding(tx, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    balance: '4000',
    source: 'manual',
  });
  await funded(tx, holding);
  return { user, institution, account, token, holding };
}

/** The reading a holding's balance comes from, dated before every movement here (A2). */
async function funded(tx: Tx, holding: { userId: string; id: string; balance: string }) {
  await seedReading(tx, {
    userId: holding.userId,
    holdingId: holding.id,
    balance: holding.balance,
    at: FUNDED_AT,
  });
}

const FUNDED_AT = new Date('2026-08-01T00:00:00Z');

/** How many rows the transfer-review queue would still ask about. */
async function reviewPrompts(tx: Tx, userId: string): Promise<number> {
  const rows = await tx
    .select({ id: schema.holdingTransactions.id })
    .from(schema.holdingTransactions)
    .where(pendingPredicate(userId));
  return rows.length;
}

async function ledger(tx: Tx, holdingId: string) {
  return await tx
    .select()
    .from(schema.holdingTransactions)
    .where(eq(schema.holdingTransactions.holdingId, holdingId));
}

async function balanceOf(tx: Tx, holdingId: string): Promise<string> {
  const [row] = await tx
    .select({ balance: schema.holdings.balance })
    .from(schema.holdings)
    .where(eq(schema.holdings.id, holdingId));
  if (!row) throw new Error('holding vanished');
  return row.balance;
}

const MOVED_AT = '2026-08-20T09:30:00.000Z';

describe('the ticket’s own measure: a 2000 withdrawal raises no prompt', () => {
  test('recording it as an outflow leaves the review queue empty', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(
        {
          direction: 'outflow',
          holdingId: holding.id,
          amount: '2000',
          occurredAt: MOVED_AT,
          destination: 'left_control',
        },
        user.id,
        tx
      );

      expect(await reviewPrompts(tx, user.id)).toBe(0);
      expect(await balanceOf(tx, holding.id)).toBe('2000');
    });
  });

  /**
   * The must-be-FOUND control. The identical withdrawal reached the way it
   * could be reached before this feature — set the balance to 2000 and say it
   * was a flow — leaves the queue holding one row.
   *
   * This is what makes the zero above a measurement. If `pendingPredicate`
   * ever stops matching (a column renamed, the import gone stale) this test
   * fails and the one above keeps passing while asserting nothing.
   */
  test('the same withdrawal as a bare balance edit leaves one', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await Container.get(UpdateHoldingUseCase).execute(
        holding.id,
        { balance: '2000', editCause: 'flow', editOccurredAt: new Date(MOVED_AT) },
        user.id,
        tx
      );

      expect(await reviewPrompts(tx, user.id)).toBe(1);
    });
  });
});

describe('an outflow', () => {
  test('writes a dated withdraw carrying the owner’s answer', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(
        {
          direction: 'outflow',
          holdingId: holding.id,
          amount: '2000',
          occurredAt: MOVED_AT,
          destination: 'untracked',
        },
        user.id,
        tx
      );

      const rows = await ledger(tx, holding.id);
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row?.kind).toBe('withdraw');
      expect(row?.source).toBe(MANUAL_EDIT_FLOW_SOURCE);
      // The date the OWNER gave, not the instant they typed it. Dating flows
      // at the edit instant is what `e1fa63e5` removed.
      expect(row?.occurredAt.toISOString()).toBe(MOVED_AT);
      expect(row?.transferReview).toBe('untracked');
      expect(row?.transferReviewSource).toBe('user');
    });
  });

  test('refuses to take more than the holding holds', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);
      await expect(
        useCase().execute(
          {
            direction: 'outflow',
            holdingId: holding.id,
            amount: '4000.01',
            occurredAt: MOVED_AT,
            destination: 'left_control',
          },
          user.id,
          tx
        )
      ).rejects.toBeInstanceOf(MovementExceedsBalanceError);
    });
  });
});

describe('an inflow', () => {
  test('raises the balance and books a deposit nobody is asked about', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);

      await useCase().execute(
        { direction: 'inflow', holdingId: holding.id, amount: '250.5', occurredAt: MOVED_AT },
        user.id,
        tx
      );

      expect(await balanceOf(tx, holding.id)).toBe('4250.5');
      const [row] = await ledger(tx, holding.id);
      expect(row?.kind).toBe('deposit');
      expect(row?.quantity).toBe('250.5');
      // `answerIsOwedFor` covers withdraw and transfer_out only, so an
      // arrival is never a queue row whatever it carries.
      expect(await reviewPrompts(tx, user.id)).toBe(0);
    });
  });

  test('on a stale stored balance it moves the engine figure by exactly the amount (A5 D-15)', async () => {
    await withTestDb(async (tx) => {
      const { user, holding } = await scaffold(tx);
      // Stored 4,100 against a reading of 4,000: a cache a writer left behind.
      await seedHoldingCache(tx, (calculator) =>
        calculator
          .update(schema.holdings)
          .set({ balance: '4100' })
          .where(eq(schema.holdings.id, holding.id))
      );

      await useCase().execute(
        { direction: 'inflow', holdingId: holding.id, amount: '5', occurredAt: MOVED_AT },
        user.id,
        tx
      );

      expect(await balanceOf(tx, holding.id)).toBe('4005');
      expect((await ledger(tx, holding.id)).map((r) => r.quantity)).toEqual(['5']);
    });
  });
});

/**
 * D-1 exception U4. A balance this path computes from the stored one is
 * written as a plain decimal: `Decimal`'s own text turns to exponent notation
 * below 1e-6, and the cache, its copy and the export would carry `5e-8`.
 */
describe('a movement that leaves dust (U4)', () => {
  /** Two manual holdings of one token, in two accounts of one person. */
  async function dust(tx: Tx, balances: { source: string; destination: string }) {
    const { user, institution, token } = await scaffold(tx);
    const holdingAt = async (balance: string) => {
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const holding = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        balance,
        source: 'manual',
      });
      await funded(tx, holding);
      return holding;
    };
    return {
      user,
      source: await holdingAt(balances.source),
      destination: await holdingAt(balances.destination),
    };
  }

  /** What the movement wrote, not the reading the fixture opened with. */
  async function copiesOf(tx: Tx, holdingId: string): Promise<string[]> {
    const rows = await tx
      .select({
        balance: schema.holdingBalanceObservations.balance,
        observedAt: schema.holdingBalanceObservations.observedAt,
      })
      .from(schema.holdingBalanceObservations)
      .where(eq(schema.holdingBalanceObservations.holdingId, holdingId));
    return rows.filter((row) => row.observedAt > FUNDED_AT).map((row) => row.balance);
  }

  test('an inflow below 1e-6 is written in plain notation, on the cache and on its copy', async () => {
    await withTestDb(async (tx) => {
      const { user, source } = await dust(tx, { source: '0', destination: '0' });

      await useCase().execute(
        { direction: 'inflow', holdingId: source.id, amount: '0.00000005', occurredAt: MOVED_AT },
        user.id,
        tx
      );

      expect(await balanceOf(tx, source.id)).toBe('0.00000005');
      expect(await copiesOf(tx, source.id)).toEqual(['0.00000005']);
    });
  });

  test('a declared transfer below 1e-6 leaves both balances in plain notation', async () => {
    await withTestDb(async (tx) => {
      const { user, source, destination } = await dust(tx, {
        source: '0.0000001',
        destination: '0',
      });

      await useCase().execute(
        {
          direction: 'transfer',
          holdingId: source.id,
          amount: '0.00000005',
          occurredAt: MOVED_AT,
          destinationAccountId: destination.accountId,
          destinationHoldingId: destination.id,
        },
        user.id,
        tx
      );

      expect({
        source: await balanceOf(tx, source.id),
        destination: await balanceOf(tx, destination.id),
      }).toEqual({ source: '0.00000005', destination: '0.00000005' });
      expect(await copiesOf(tx, source.id)).toEqual(['0.00000005']);
      expect(await copiesOf(tx, destination.id)).toEqual(['0.00000005']);
    });
  });
});

describe('a declared transfer', () => {
  test('moves both balances and links the legs as one pair', async () => {
    await withTestDb(async (tx) => {
      const { user, institution, token, holding } = await scaffold(tx);
      const other = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const destination = await makeHolding(tx, {
        userId: user.id,
        accountId: other.id,
        tokenId: token.id,
        balance: '10',
        source: 'manual',
      });
      await funded(tx, destination);

      const result = await useCase().execute(
        {
          direction: 'transfer',
          holdingId: holding.id,
          amount: '2000',
          occurredAt: MOVED_AT,
          destinationAccountId: other.id,
          destinationHoldingId: destination.id,
        },
        user.id,
        tx
      );

      expect(await balanceOf(tx, holding.id)).toBe('2000');
      // The half this cannot get from `writeInflow`, which inserts the arrival
      // row and leaves an existing destination's balance untouched.
      expect(await balanceOf(tx, destination.id)).toBe('2010');

      const [out] = await ledger(tx, holding.id);
      const [arrival] = await ledger(tx, destination.id);
      expect(out?.kind).toBe('withdraw');
      expect(arrival?.kind).toBe('deposit');
      expect(out?.transferGroupId).toBe(result.transferGroupId);
      expect(arrival?.transferGroupId).toBe(result.transferGroupId);
      expect(result.transferGroupId).not.toBeNull();

      // A paired outflow is out of the queue on the group id alone — the
      // reason a transfer needs no `transfer_review` answer from the owner.
      expect(await reviewPrompts(tx, user.id)).toBe(0);

      // The stamp is PROVENANCE rather than queue control, which is exactly
      // why it needs its own assertion: the prompt count above is already 0
      // without it, so nothing else in this file would notice it going away.
      // Without it `answerSourceOf` reads a transfer the owner declared as
      // `unattributed` — indistinguishable from one the nightly matcher
      // guessed at.
      expect(out?.transferReview).toBe('paired');
      expect(out?.transferReviewSource).toBe('user');
    });
  });

  test('creates the destination holding when the account holds none', async () => {
    await withTestDb(async (tx) => {
      const { user, institution, token, holding } = await scaffold(tx);
      const fresh = await makeAccount(tx, { userId: user.id, institutionId: institution.id });

      const result = await useCase().execute(
        {
          direction: 'transfer',
          holdingId: holding.id,
          amount: '2000',
          occurredAt: MOVED_AT,
          destinationAccountId: fresh.id,
        },
        user.id,
        tx
      );

      expect(result.destinationHoldingId).not.toBeNull();
      const created = result.destinationHoldingId;
      if (!created) throw new Error('no destination');
      // Opened at zero and then moved by the ordinary flow, so the arrival is
      // a ledger row rather than an opening figure with nothing explaining it.
      expect(await balanceOf(tx, created)).toBe('2000');
      const [arrival] = await ledger(tx, created);
      expect(arrival?.kind).toBe('deposit');
      expect(arrival?.quantity).toBe('2000');

      const [row] = await tx
        .select({ tokenId: schema.holdings.tokenId, accountId: schema.holdings.accountId })
        .from(schema.holdings)
        .where(eq(schema.holdings.id, created));
      expect(row?.tokenId).toBe(token.id);
      expect(row?.accountId).toBe(fresh.id);
      expect(await reviewPrompts(tx, user.id)).toBe(0);
    });
  });

  test('refuses to send a holding to itself', async () => {
    await withTestDb(async (tx) => {
      const { user, account, holding } = await scaffold(tx);
      await expect(
        useCase().execute(
          {
            direction: 'transfer',
            holdingId: holding.id,
            amount: '10',
            occurredAt: MOVED_AT,
            destinationAccountId: account.id,
            destinationHoldingId: holding.id,
          },
          user.id,
          tx
        )
      ).rejects.toBeInstanceOf(MovementSameHoldingError);
    });
  });
});

describe('ownership', () => {
  test('another user’s holding reads as absent, not as a balance', async () => {
    await withTestDb(async (tx) => {
      const { holding } = await scaffold(tx);
      const stranger = await makeUser(tx);
      await expect(
        useCase().execute(
          { direction: 'inflow', holdingId: holding.id, amount: '1', occurredAt: MOVED_AT },
          stranger.id,
          tx
        )
      ).rejects.toThrow();
    });
  });
});

/**
 * A declared transfer that cost something, reached from the MOVEMENT form
 * (SC-889).
 *
 * SC-857 built this model on the balance-edit path and left this one unable to
 * express it: `execute` passes an `editOutflow` only on `direction: 'outflow'`,
 * so the transfer branch had no answer object for a fee to travel in. The
 * consequence was silent rather than loud — `RecordHoldingMovementDto` is a
 * discriminated union of plain objects, so a client that sent a fee got
 * `success: true` with the field STRIPPED, and both legs booked the full
 * amount.
 *
 * These assert the shape SC-857 decided rather than re-deciding it: the fee is
 * an outflow from the SOURCE, carved OUT of the withdrawal, and the arrival is
 * what arrived.
 */
describe('a declared transfer that cost something (SC-889)', () => {
  /** Source at 4,000 and a destination at 10, in the same token. */
  async function pair(tx: Tx) {
    const base = await scaffold(tx);
    const other = await makeAccount(tx, {
      userId: base.user.id,
      institutionId: base.institution.id,
    });
    const destination = await makeHolding(tx, {
      userId: base.user.id,
      accountId: other.id,
      tokenId: base.token.id,
      balance: '10',
      source: 'manual',
    });
    await funded(tx, destination);
    return { ...base, other, destination };
  }

  test('the fee is carved OUT of the withdrawal and the arrival is what arrived', async () => {
    await withTestDb(async (tx) => {
      const { user, holding, other, destination } = await pair(tx);

      await useCase().execute(
        {
          direction: 'transfer',
          holdingId: holding.id,
          amount: '251.33',
          occurredAt: MOVED_AT,
          destinationAccountId: other.id,
          destinationHoldingId: destination.id,
          feeQuantity: '1.33',
        },
        user.id,
        tx
      );

      // The owner stated what LEFT, so the source anchor falls by all of it.
      expect(await balanceOf(tx, holding.id)).toBe('3748.67');
      // And the destination gets what ARRIVED — 250, not 251.33. Reading
      // 261.33 here is the whole defect: the sent amount on both legs.
      expect(await balanceOf(tx, destination.id)).toBe('260');

      const source = await ledger(tx, holding.id);
      expect(source).toHaveLength(2);
      const withdraw = source.find((row) => row.kind === 'withdraw');
      const fee = source.find((row) => row.kind === 'fee');
      expect(withdraw?.quantity).toBe('-250');
      expect(fee?.quantity).toBe('-1.33');
      // Same instant as the payment that incurred it: the ledger is ordered by
      // `occurred_at` and a fee that sorts away from its payment reads as an
      // unexplained charge.
      expect(fee?.occurredAt.toISOString()).toBe(MOVED_AT);

      const arrival = await ledger(tx, destination.id);
      expect(arrival).toHaveLength(1);
      expect(arrival[0]?.kind).toBe('deposit');
      expect(arrival[0]?.quantity).toBe('250');
    });
  });

  /**
   * The identity `OpeningBalanceReconciliationService` depends on.
   *
   * It computes `holdings.balance - sum(real txs)` and synthesizes an
   * `opening_balance` for the difference, so a fee ADDED BESIDE a full-amount
   * withdrawal (-251.33 + -1.33 = -252.66 against an anchor that moved
   * -251.33) manufactures a phantom 1.33 opening on this very holding.
   *
   * Asserted as arithmetic over the rows rather than by naming them, so it
   * still fires if a future change writes a third row nobody thought about.
   */
  test('the source rows sum to exactly the delta its anchor moved by', async () => {
    await withTestDb(async (tx) => {
      const { user, holding, other, destination } = await pair(tx);
      const before = new Decimal(await balanceOf(tx, holding.id));

      await useCase().execute(
        {
          direction: 'transfer',
          holdingId: holding.id,
          amount: '251.33',
          occurredAt: MOVED_AT,
          destinationAccountId: other.id,
          destinationHoldingId: destination.id,
          feeQuantity: '1.33',
        },
        user.id,
        tx
      );

      const after = new Decimal(await balanceOf(tx, holding.id));
      const rows = await ledger(tx, holding.id);
      // Two rows, or the sum below is an identity the unfixed code satisfies
      // trivially by writing one full-amount withdrawal and no fee at all.
      expect(rows).toHaveLength(2);
      const summed = rows.reduce((total, row) => total.add(row.quantity), new Decimal(0));
      expect(summed.toString()).toBe(after.sub(before).toString());
      expect(summed.toString()).toBe('-251.33');
    });
  });

  /**
   * SC-150, restated as a test rather than as a comment.
   *
   * `CostBasisService`'s inflow branch hands the FIRST `transfer_in` every
   * buffered lot and then `pending.delete(tgid)`, so a second row on one group
   * id opens a fresh market-value lot and invents a gain. The fee must
   * therefore carry no `transfer_group_id` — and `linkDeclaredPair` refuses a
   * pairing that touches anything other than exactly two rows, so a fee that
   * drifted onto the group would also roll the transfer back.
   */
  test('the fee row carries no transfer_group_id, so the group is still exactly two rows', async () => {
    await withTestDb(async (tx) => {
      const { user, holding, other, destination } = await pair(tx);

      const result = await useCase().execute(
        {
          direction: 'transfer',
          holdingId: holding.id,
          amount: '251.33',
          occurredAt: MOVED_AT,
          destinationAccountId: other.id,
          destinationHoldingId: destination.id,
          feeQuantity: '1.33',
        },
        user.id,
        tx
      );

      expect(result.transferGroupId).not.toBeNull();
      const fee = (await ledger(tx, holding.id)).find((row) => row.kind === 'fee');
      expect(fee).toBeDefined();
      expect(fee?.transferGroupId).toBeNull();

      const grouped = await tx
        .select({ kind: schema.holdingTransactions.kind })
        .from(schema.holdingTransactions)
        .where(eq(schema.holdingTransactions.transferGroupId, result.transferGroupId ?? ''));
      expect(grouped).toHaveLength(2);
      expect(grouped.filter((row) => row.kind === 'deposit')).toHaveLength(1);

      // And the declaration still answers the queue, fee or no fee.
      expect(await reviewPrompts(tx, user.id)).toBe(0);
    });
  });

  /**
   * A fee that is not smaller than the movement leaves nothing to transfer,
   * and `feeFitsMovement` is the one predicate that says so. Refused through
   * `ManualBalanceEditService`'s own error rather than a second rule here, so
   * the two surfaces cannot disagree about what fits.
   *
   * The refusal lands on the SOURCE leg, which is written first — so the
   * destination is never touched and no pair is ever linked. That is the half
   * this test can see. It deliberately does NOT assert that the source is
   * untouched: `execute` was handed this test's own transaction, so it runs
   * `run(tx)` directly and the rollback belongs to the caller. In production
   * the router calls it with no transaction, `withTransaction` opens one, and
   * the throw discards the whole movement — a claim about `withTransaction`
   * rather than about this use case, and asserting it here would need a
   * committed database instead of `withTestDb`'s rollback.
   */
  test('a fee that is not smaller than the movement is refused before the arrival is written', async () => {
    await withTestDb(async (tx) => {
      const { user, holding, other, destination } = await pair(tx);

      await expect(
        useCase().execute(
          {
            direction: 'transfer',
            holdingId: holding.id,
            amount: '251.33',
            occurredAt: MOVED_AT,
            destinationAccountId: other.id,
            destinationHoldingId: destination.id,
            feeQuantity: '251.33',
          },
          user.id,
          tx
        )
      ).rejects.toBeInstanceOf(ManualEditFeeRefused);

      expect(await balanceOf(tx, destination.id)).toBe('10');
      expect(await ledger(tx, destination.id)).toHaveLength(0);
    });
  });

  /**
   * The must-be-FOUND control for every assertion above. Without it, a
   * `feeQuantity` the DTO strips or the use case ignores would read exactly
   * like a fee correctly applied to a transfer that happened to have none —
   * the arrival is 251.33 either way, and no assertion here could tell them
   * apart.
   */
  test('the same transfer with no fee puts the whole amount on both legs', async () => {
    await withTestDb(async (tx) => {
      const { user, holding, other, destination } = await pair(tx);

      await useCase().execute(
        {
          direction: 'transfer',
          holdingId: holding.id,
          amount: '251.33',
          occurredAt: MOVED_AT,
          destinationAccountId: other.id,
          destinationHoldingId: destination.id,
        },
        user.id,
        tx
      );

      expect(await balanceOf(tx, destination.id)).toBe('261.33');
      expect(await ledger(tx, holding.id)).toHaveLength(1);
    });
  });
});

/** Rows a test committed, deleted after it: history and labels read committed rows only. */
const created = committedRows();

/**
 * An account the exchange sync owns. Its own institution: the credential is
 * per (user, institution), so one on the scaffold's would make every account
 * there sync-owned.
 */
async function exchangeAccount(tx: Tx, userId: string) {
  const institution = await makeInstitution(tx);
  await makeCredential(tx, { userId, institutionId: institution.id });
  return await makeAccount(tx, { userId, institutionId: institution.id });
}

async function transferInto(
  tx: Tx,
  from: { userId: string; holdingId: string },
  destinationAccountId: string,
  amount: string
) {
  const result = await useCase().execute(
    {
      direction: 'transfer',
      holdingId: from.holdingId,
      amount,
      occurredAt: MOVED_AT,
      destinationAccountId,
    },
    from.userId,
    tx
  );
  if (!result.destinationHoldingId) throw new Error('no destination');
  return result.destinationHoldingId;
}

async function holdingRow(tx: Tx, holdingId: string) {
  const [row] = await tx.select().from(schema.holdings).where(eq(schema.holdings.id, holdingId));
  if (!row) throw new Error(`holding ${holdingId} is gone`);
  return row;
}

function observationsOf(tx: Tx, holdingId: string) {
  return tx
    .select()
    .from(schema.holdingBalanceObservations)
    .where(eq(schema.holdingBalanceObservations.holdingId, holdingId));
}

/**
 * Where a declared transfer opens its destination (`DeclaredTransferService`),
 * pinned on today's code before that INSERT moves onto `HoldingResolver`
 * (foundation A2). Every assertion here reads the same after the move (D-1).
 */
describe('a declared transfer’s created destination, pinned before it moves (foundation A2)', () => {
  afterEach(created.drop);

  /** What the destination row, its ledger and its observations hold after the transfer. */
  async function openedDestination(tx: Tx, holdingId: string) {
    const row = await holdingRow(tx, holdingId);
    return {
      row: {
        accountId: row.accountId,
        tokenId: row.tokenId,
        balance: row.balance,
        source: row.source,
        arrival: row.arrival,
        externalId: row.externalId,
        label: row.label,
        isActive: row.isActive,
        isHidden: row.isHidden,
        manualEditCause: row.manualEditCause,
      },
      lastUpdated: row.lastUpdated,
      ledger: (await ledger(tx, holdingId)).map((r) => ({
        kind: r.kind,
        quantity: r.quantity,
        occurredAt: r.occurredAt.toISOString(),
        source: r.source,
      })),
      observations: (await observationsOf(tx, holdingId)).map((o) => ({
        balance: o.balance,
        source: o.source,
        sourceMetadata: o.sourceMetadata,
        gapReview: o.gapReview,
        authority: o.authority,
        inputId: o.inputId,
        cause: o.cause,
      })),
    };
  }

  /** The one observation the arrival leg writes, and none at the zero the row opened at. */
  const arrivalObservation = (balance: string) => ({
    balance,
    source: 'sync-capture',
    sourceMetadata: { origin: 'updateHolding' },
    gapReview: 'flow',
    authority: 'person' as const,
    inputId: null,
    cause: 'flow' as const,
  });

  const arrivalRow = (quantity: string) => ({
    kind: 'deposit',
    quantity,
    occurredAt: MOVED_AT,
    source: MANUAL_EDIT_FLOW_SOURCE,
  });

  test('an unsynced account’s destination opens as a manual row at zero and the arrival moves it: one deposit, one observation', async () => {
    await withTestDb(async (tx) => {
      const { user, institution, token, holding } = await scaffold(tx);
      const fresh = await makeAccount(tx, { userId: user.id, institutionId: institution.id });

      const opened = await transferInto(
        tx,
        { userId: user.id, holdingId: holding.id },
        fresh.id,
        '2000'
      );

      const destination = await openedDestination(tx, opened);
      expect(destination.row).toEqual({
        accountId: fresh.id,
        tokenId: token.id,
        balance: '2000',
        source: 'manual',
        arrival: 'user_confirmed',
        externalId: null,
        label: null,
        isActive: true,
        isHidden: false,
        manualEditCause: 'flow',
      });
      // Both legs share the movement's one edit instant (`editedAt`).
      expect(destination.lastUpdated).toEqual((await holdingRow(tx, holding.id)).lastUpdated);
      expect(destination.ledger).toEqual([arrivalRow('2000')]);
      expect(destination.observations).toEqual([arrivalObservation('2000')]);
    });
  });

  test('a sync-owned account’s destination opens under the sync’s source (SC-356): blockchain for a wallet, sync_exchange_balances for an exchange', async () => {
    await withTestDb(async (tx) => {
      const { user, institution, token, holding } = await scaffold(tx);
      const wallet = await makeWalletAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
      });
      const exchange = await exchangeAccount(tx, user.id);
      const from = { userId: user.id, holdingId: holding.id };

      const intoWallet = await openedDestination(
        tx,
        await transferInto(tx, from, wallet.id, '1000')
      );
      const intoExchange = await openedDestination(
        tx,
        await transferInto(tx, from, exchange.id, '1500')
      );

      const common = {
        tokenId: token.id,
        arrival: 'user_confirmed',
        externalId: null,
        label: null,
        isActive: true,
        isHidden: false,
        manualEditCause: 'flow',
      };
      expect(intoWallet.row).toEqual({
        ...common,
        accountId: wallet.id,
        balance: '1000',
        source: 'blockchain',
      });
      expect(intoExchange.row).toEqual({
        ...common,
        accountId: exchange.id,
        balance: '1500',
        source: 'sync_exchange_balances',
      });
      expect(intoWallet.ledger).toEqual([arrivalRow('1000')]);
      expect(intoExchange.ledger).toEqual([arrivalRow('1500')]);
      expect(intoWallet.observations).toEqual([arrivalObservation('1000')]);
      expect(intoExchange.observations).toEqual([arrivalObservation('1500')]);
      expect(await balanceOf(tx, holding.id)).toBe('1500');
    });
  });

  test('history across a declared transfer into a created destination reads as it did before the move', async () => {
    const at = (iso: string) => new Date(iso);
    const fixture = await getDb().transaction(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      // One source per destination, each observed once: a second transfer
      // dated before the first one's observation would leave drift in the
      // first interval, spread over a span that ends at the wall clock.
      const observedSource = async () => {
        const token = await makeToken(tx);
        created.tokens.push(token.id);
        const holding = await makeHolding(tx, {
          userId: user.id,
          accountId: account.id,
          tokenId: token.id,
          balance: '4000',
          source: 'manual',
          createdAt: at('2026-06-01T00:00:00.000Z'),
          lastUpdated: at('2026-06-01T00:00:00.000Z'),
        });
        await tx.insert(schema.holdingBalanceObservations).values({
          userId: user.id,
          holdingId: holding.id,
          balance: '4000',
          observedAt: at('2026-06-01T00:00:00.000Z'),
          source: 'sync-capture',
          sourceMetadata: { origin: 'updateHolding' },
        });
        return holding.id;
      };
      const fresh = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const wallet = await makeWalletAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
      });
      created.users.push(user.id);
      created.institutions.push(institution.id);
      return {
        userId: user.id,
        manualSourceId: await observedSource(),
        walletSourceId: await observedSource(),
        freshId: fresh.id,
        walletId: wallet.id,
      };
    });
    const { userId, manualSourceId, walletSourceId } = fixture;

    const intoManual = await getDb().transaction((tx) =>
      transferInto(tx, { userId, holdingId: manualSourceId }, fixture.freshId, '2000')
    );
    const intoWallet = await getDb().transaction((tx) =>
      transferInto(tx, { userId, holdingId: walletSourceId }, fixture.walletId, '500')
    );

    // Read on the path before the move. The source falls by exactly what
    // left, so no drift is spread; each destination reads the arrival after
    // it. Since A5 PR-2 (D-10) a holding reads absent before its start: the
    // source before 1 June, and each destination before its arrival, where
    // the old walk read 4000 and 0.
    const now = new Date();
    const golden: Array<[string, Date, string | null]> = [
      [manualSourceId, at('2026-05-15T00:00:00.000Z'), null],
      [manualSourceId, at('2026-08-19T00:00:00.000Z'), '4000'],
      [manualSourceId, at('2026-08-21T00:00:00.000Z'), '2000'],
      [manualSourceId, now, '2000'],
      [walletSourceId, at('2026-08-19T00:00:00.000Z'), '4000'],
      [walletSourceId, at('2026-08-21T00:00:00.000Z'), '3500'],
      [walletSourceId, now, '3500'],
      [intoManual, at('2026-08-19T00:00:00.000Z'), null],
      [intoManual, at('2026-08-21T00:00:00.000Z'), '2000'],
      [intoManual, now, '2000'],
      [intoWallet, at('2026-08-19T00:00:00.000Z'), null],
      [intoWallet, at('2026-08-21T00:00:00.000Z'), '500'],
      [intoWallet, now, '500'],
    ];
    const readings: HistoryReading[] = golden.map(([holdingId, instant, balance]) => ({
      holdingId,
      at: instant,
      balance,
      anchor: null,
    }));

    await expectHistoryUnchanged(readings);
    // The control: a figure the walk does not give is caught.
    await expect(
      expectHistoryUnchanged(readings.map((r, i) => (i === 8 ? { ...r, balance: '0' } : r)))
    ).rejects.toThrow();
  });
});

/**
 * The destination comes from `HoldingResolver` (foundation A2, D-4, D-6): a
 * feed holding when a sync owns the account, else a snapshot one, starting at
 * the arrival's date and opened with no observation. The row, the ledger, the
 * cache and history are the characterization's above (D-1).
 */
describe('a declared transfer’s created destination comes from HoldingResolver (foundation A2)', () => {
  afterEach(created.drop);

  /** The arrival leg's observation, with its labels. */
  async function labelledObservations(tx: Tx, holdingId: string) {
    return (await observationsOf(tx, holdingId)).map((o) => ({
      balance: o.balance,
      role: o.role,
      authority: o.authority,
      inputId: o.inputId,
      cause: o.cause,
      supersededAt: o.supersededAt,
    }));
  }

  test('an unsynced account’s destination is a snapshot holding starting at the transfer’s date, and the arrival is its first snapshot', async () => {
    await withTestDb(async (tx) => {
      const { user, institution, holding } = await scaffold(tx);
      const fresh = await makeAccount(tx, { userId: user.id, institutionId: institution.id });

      const opened = await transferInto(
        tx,
        { userId: user.id, holdingId: holding.id },
        fresh.id,
        '2000'
      );

      const row = await holdingRow(tx, opened);
      expect({ kind: row.kind, startsAt: row.startsAt }).toEqual({
        kind: 'snapshot',
        startsAt: new Date(MOVED_AT),
      });
      expect(await labelledObservations(tx, opened)).toEqual([
        {
          balance: '2000',
          role: 'snapshot',
          authority: 'person',
          inputId: null,
          cause: 'flow',
          supersededAt: null,
        },
      ]);
    });
  });

  // Rule P (D7, R85): the feed has produced no evidence yet, so the arrival a
  // person declared is a snapshot, as the backfill would label it.
  test('a sync-owned account’s destination is a feed holding starting at the transfer’s date, and the arrival, before its feed’s first evidence, is a snapshot', async () => {
    await withTestDb(async (tx) => {
      const { user, institution, holding } = await scaffold(tx);
      const from = { userId: user.id, holdingId: holding.id };
      const wallet = await makeWalletAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
      });
      const exchange = await exchangeAccount(tx, user.id);

      for (const [accountId, amount] of [
        [wallet.id, '1000'],
        [exchange.id, '1500'],
      ] as const) {
        const opened = await transferInto(tx, from, accountId, amount);
        const row = await holdingRow(tx, opened);
        expect({ kind: row.kind, startsAt: row.startsAt }).toEqual({
          kind: 'feed',
          startsAt: new Date(MOVED_AT),
        });
        expect(await labelledObservations(tx, opened)).toEqual([
          {
            balance: amount,
            role: 'snapshot',
            authority: 'person',
            inputId: null,
            cause: 'flow',
            supersededAt: null,
          },
        ]);
      }
      await expectPersonRolesAsClassified(user.id, tx);
    });
  });

  test('expectLabelsSettled after declared transfers open a snapshot and a feed destination', async () => {
    const fixture = await getDb().transaction(async (tx) => {
      const user = await makeUser(tx);
      const institution = await makeInstitution(tx);
      const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const sources: string[] = [];
      for (let i = 0; i < 2; i++) {
        const token = await makeToken(tx);
        created.tokens.push(token.id);
        const holding = await makeHolding(tx, {
          userId: user.id,
          accountId: account.id,
          tokenId: token.id,
          balance: '4000',
          source: 'manual',
        });
        await funded(tx, holding);
        sources.push(holding.id);
      }
      const fresh = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
      const wallet = await makeWalletAccount(tx, {
        userId: user.id,
        institutionId: institution.id,
      });
      created.users.push(user.id);
      created.institutions.push(institution.id);
      return { userId: user.id, sources, freshId: fresh.id, walletId: wallet.id };
    });
    // The sources settled first, as the backfill leaves them.
    await Container.get(FoundationClassificationService).classify({
      apply: true,
      userId: fixture.userId,
    });

    const [intoManual, intoWallet] = fixture.sources;
    if (!intoManual || !intoWallet) throw new Error('two sources');
    await getDb().transaction((tx) =>
      transferInto(tx, { userId: fixture.userId, holdingId: intoManual }, fixture.freshId, '2000')
    );
    await getDb().transaction((tx) =>
      transferInto(tx, { userId: fixture.userId, holdingId: intoWallet }, fixture.walletId, '500')
    );

    await expectLabelsSettled(fixture.userId);
  });
});
