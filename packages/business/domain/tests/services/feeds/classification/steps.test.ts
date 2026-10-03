/**
 * Classification steps 2 and 3 (foundation A2 D-10): an own wallet address,
 * then a person's rule on the input. The steps are pure and read through
 * `decide`; the rule keys come from the database, and a rule's kind is written
 * by ingest.
 */

import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { asc, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { FeedInputRepository } from '../../../../src/repositories/FeedInputRepository';
import {
  FeedMatchRuleRepository,
  type MatchRule,
} from '../../../../src/repositories/FeedMatchRuleRepository';
import {
  type ClassifiableEntry,
  type ClassificationContext,
  decide,
} from '../../../../src/services/feeds/classification/steps';
import { FeedIngestService } from '../../../../src/services/feeds/FeedIngestService';
import type { FeedBatch, FeedEntry } from '../../../../src/services/feeds/feed-batch';
import { withTestDb } from '../../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../../test/helpers/factories';
import { makeAccount, makeToken } from '../../../../test/helpers/factories-extra';

/** A wallet address built at run time, so no address-shaped literal is committed. */
const wallet = (digit: string) => `0x${digit.repeat(40)}`;

const SOURCE = 'test-feed';
const T1 = new Date('2026-07-01T10:00:00Z');
const FETCHED = new Date('2026-07-10T00:00:00Z');

function entryOf(fields: Partial<ClassifiableEntry> = {}): ClassifiableEntry {
  return {
    accountId: randomUUID(),
    chainKey: '1',
    counterpartyAddress: null,
    counterpartyKey: null,
    description: null,
    ...fields,
  };
}

function rule(fields: Partial<MatchRule> & Pick<MatchRule, 'matchField' | 'pattern'>): MatchRule {
  return {
    id: randomUUID(),
    destinationAccountId: null,
    ledgerKind: null,
    counterpartyKey: null,
    ...fields,
  };
}

const context = (fields: Partial<ClassificationContext> = {}): ClassificationContext => ({
  ownWallets: [],
  rules: [],
  ...fields,
});

describe('step 2, own address', () => {
  test('own address: one candidate on the same chain gives a destination; two candidates give none', () => {
    const address = wallet('a');
    const [one, two] = [randomUUID(), randomUUID()];
    const entry = entryOf({ counterpartyAddress: address });

    expect(
      decide(entry, context({ ownWallets: [{ address, chainKey: '1', accountId: one }] }))
    ).toEqual({ destinationAccountId: one });
    expect(
      decide(
        entry,
        context({
          ownWallets: [
            { address, chainKey: '1', accountId: one },
            { address, chainKey: '1', accountId: two },
          ],
        })
      )
    ).toBeNull();
  });

  test("the entry's own account is never a candidate, and neither is another chain's (R45)", () => {
    const address = wallet('b');
    const own = randomUUID();
    const other = randomUUID();
    const entry = entryOf({ accountId: own, counterpartyAddress: address });
    const ownWallets = [
      { address, chainKey: '1', accountId: own },
      { address, chainKey: '137', accountId: randomUUID() },
      { address, chainKey: '1', accountId: other },
    ];

    expect(decide(entry, context({ ownWallets }))).toEqual({ destinationAccountId: other });
    expect(
      decide(
        entryOf({ accountId: own, counterpartyAddress: address }),
        context({ ownWallets: ownWallets.slice(0, 2) })
      )
    ).toBeNull();
    // An off-chain entry is on no chain an address lives on.
    expect(decide({ ...entry, chainKey: null }, context({ ownWallets }))).toBeNull();
  });
});

describe('step 3, a user rule', () => {
  test('a description rule matches after normalizeDescription', () => {
    const savings = randomUUID();
    const rules = [
      rule({ matchField: 'description', pattern: 'to savings', destinationAccountId: savings }),
    ];

    // NFKC folds the fullwidth letters, and every run of white space is one space.
    const verdict = decide(entryOf({ description: '  ＴＯ  Savings\t' }), context({ rules }));
    expect(verdict).toEqual({ destinationAccountId: savings });
    expect(decide(entryOf({ description: 'to savings account' }), context({ rules }))).toBeNull();
    expect(decide(entryOf({ description: null }), context({ rules }))).toBeNull();
  });

  test('a counterparty rule matches through transfer_counterparty_key', async () => {
    await withTestDb(async (tx) => {
      const { userId, inputId } = await inputFixture(tx);
      await tx.insert(schema.feedMatchRules).values({
        userId,
        inputId,
        matchField: 'counterparty',
        pattern: 'Pay 100.00 USD to Example Recipient (Savings)',
        ledgerKind: 'transfer_out',
        createdBy: 'person',
      });
      const repo = Container.get(FeedMatchRuleRepository);
      const rules = await repo.findForInput(userId, inputId, tx);
      const sameRecipient = 'pay 2,500.00 eur to  Example Recipient (Savings)';
      const otherPurpose = 'Pay 100.00 USD to Example Recipient (Loan)';
      const keys = await repo.counterpartyKeys([sameRecipient, otherPurpose], tx);

      expect(rules.map((r) => r.counterpartyKey)).toEqual(['example recipient (savings)']);
      expect(
        decide(entryOf({ counterpartyKey: keys.get(sameRecipient) ?? null }), context({ rules }))
      ).toEqual({ ledgerKind: 'transfer_out' });
      expect(
        decide(entryOf({ counterpartyKey: keys.get(otherPurpose) ?? null }), context({ rules }))
      ).toBeNull();
    });
  });

  test('rules that match and disagree decide nothing; rules that agree decide', () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const entry = entryOf({ description: 'rent', counterpartyKey: 'landlord' });
    const byDescription = rule({
      matchField: 'description',
      pattern: 'Rent',
      destinationAccountId: a,
    });

    expect(
      decide(
        entry,
        context({
          rules: [
            byDescription,
            rule({
              matchField: 'counterparty',
              pattern: 'x',
              counterpartyKey: 'landlord',
              destinationAccountId: b,
            }),
          ],
        })
      )
    ).toBeNull();
    expect(
      decide(
        entry,
        context({
          rules: [
            byDescription,
            rule({
              matchField: 'counterparty',
              pattern: 'x',
              counterpartyKey: 'landlord',
              destinationAccountId: a,
            }),
          ],
        })
      )
    ).toEqual({ destinationAccountId: a });
  });
});

describe('the order of the steps', () => {
  test('the first deciding step wins, and an entry no step decides stays unclassified', () => {
    const address = wallet('c');
    const [walletAccount, savings] = [randomUUID(), randomUUID()];
    const ctx = context({
      ownWallets: [{ address, chainKey: '1', accountId: walletAccount }],
      rules: [
        rule({ matchField: 'description', pattern: 'to savings', destinationAccountId: savings }),
      ],
    });

    expect(
      decide(entryOf({ counterpartyAddress: address, description: 'to savings' }), ctx)
    ).toEqual({ destinationAccountId: walletAccount });
    expect(decide(entryOf({ description: 'to savings' }), ctx)).toEqual({
      destinationAccountId: savings,
    });
    expect(decide(entryOf({ description: 'groceries' }), ctx)).toBeNull();
  });
});

async function inputFixture(tx: DatabaseTransaction) {
  const userId = (await makeUser(tx)).id;
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId, institutionId: institution.id });
  const input = await Container.get(FeedInputRepository).findOrCreate(
    { userId, accountId: account.id, source: SOURCE, credentialId: null, walletId: null },
    tx
  );
  return { userId, accountId: account.id, inputId: input.id };
}

describe('a verdict through ingest', () => {
  test("a rule's kind is written with kind_origin rule, and a replay leaves it", async () => {
    await withTestDb(async (tx) => {
      const { userId, accountId, inputId } = await inputFixture(tx);
      const token = await makeToken(tx, {
        symbol: `T${randomUUID().replace(/-/g, '').toUpperCase()}`,
      });
      await tx.insert(schema.feedMatchRules).values({
        userId,
        inputId,
        matchField: 'description',
        pattern: 'Interest payment',
        ledgerKind: 'income',
        createdBy: 'person',
      });
      const deposit = (externalId: string, description: string): FeedEntry => ({
        externalId,
        asset: {
          identity: { symbol: token.symbol, name: token.symbol },
          typeCode: 'crypto',
          lookup: 'catalog-symbol',
        },
        amount: '5',
        occurredAt: T1,
        description,
        legacy: { kind: 'deposit', source: SOURCE, sourceMetadata: {} },
      });
      const batch: FeedBatch = {
        userId,
        input: { accountId, source: SOURCE, credentialId: null, walletId: null },
        fetchedAt: FETCHED,
        window: { from: T1, to: FETCHED, complete: false },
        checkpoints: [],
        entries: [deposit('in-1', 'INTEREST  payment'), deposit('in-2', 'Top-up')],
        absences: [],
        legacy: {
          holdingMatch: 'ingest-order',
          holdingPolicy: 'create',
          holdingSource: 'ingest-backfill',
          arrival: null,
          writesCache: false,
          createdWithoutCheckpoint: 'zero',
          cacheObservation: null,
          derivesTradeLegs: false,
          holdingFailure: 'skip-entry',
          absence: null,
          clearsAbsenceTally: false,
          createdCheckpointMeta: null,
          unhideOnNonZero: false,
          unchangedCheckpoint: 'append',
          zeroOpensHolding: true,
        },
        notices: [],
      };
      const labels = async () =>
        (
          await tx
            .select()
            .from(schema.holdingTransactions)
            .where(eq(schema.holdingTransactions.userId, userId))
            .orderBy(asc(schema.holdingTransactions.externalId))
        ).map((r) => ({
          externalId: r.externalId,
          ledgerKind: r.ledgerKind,
          kindOrigin: r.kindOrigin,
        }));

      await Container.get(FeedIngestService).ingest(batch, tx);
      const first = await labels();
      await Container.get(FeedIngestService).ingest(batch, tx);

      expect(first).toEqual([
        { externalId: 'in-1', ledgerKind: 'income', kindOrigin: 'rule' },
        { externalId: 'in-2', ledgerKind: 'inflow', kindOrigin: 'source' },
      ]);
      expect(await labels()).toEqual(first);
    });
  });
});
