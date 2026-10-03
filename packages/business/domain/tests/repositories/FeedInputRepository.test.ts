import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { FeedInputRepository } from '../../src/repositories/FeedInputRepository';
import type {
  AccountInputFacts,
  PlannedFeedInput,
} from '../../src/services/foundation/plan-feed-inputs';
import { withTestDb } from '../../test/helpers/db';
import { makeCredential, makeInstitution, makeUser } from '../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../test/helpers/factories-extra';

const repo = () => Container.get(FeedInputRepository);
const byAccount = (a: { accountId: string }, b: { accountId: string }) =>
  a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0;

async function makeWallet(tx: DatabaseTransaction, userId: string, isActive: boolean) {
  const [row] = await tx
    .insert(schema.userWallets)
    .values({ userId, walletAddress: `0x${randomUUID().replace(/-/g, '')}`, isActive })
    .returning();
  return row!;
}

interface Seeded {
  account: typeof schema.accounts.$inferSelect;
  institution: typeof schema.institutions.$inferSelect;
  holding: typeof schema.holdings.$inferSelect;
}

/** An account at its own institution, holding one token from `holdingSource`. */
async function seedAccount(
  tx: DatabaseTransaction,
  userId: string,
  holdingSource: string,
  metadata: Record<string, unknown> = {}
): Promise<Seeded> {
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId, institutionId: institution.id, metadata });
  const holding = await makeHolding(tx, {
    userId,
    accountId: account.id,
    tokenId: (await makeToken(tx)).id,
    source: holdingSource,
  });
  return { account, institution, holding };
}

const ledgerRow = (tx: DatabaseTransaction, seeded: Seeded, source: string) =>
  makeHoldingTransaction(tx, {
    userId: seeded.holding.userId,
    holdingId: seeded.holding.id,
    tokenId: seeded.holding.tokenId,
    source,
  });

const observation = (tx: DatabaseTransaction, seeded: Seeded, source: string) =>
  tx.insert(schema.holdingBalanceObservations).values({
    userId: seeded.holding.userId,
    holdingId: seeded.holding.id,
    balance: '1',
    observedAt: new Date('2026-01-31T00:00:00Z'),
    source,
  });

function facts(seeded: Seeded, fields: Partial<AccountInputFacts> = {}): AccountInputFacts {
  return {
    userId: seeded.account.userId,
    accountId: seeded.account.id,
    institutionName: seeded.institution.name,
    chainId: null,
    walletId: null,
    walletActive: false,
    credentialId: null,
    credentialActive: false,
    hasProviderHoldings: false,
    hasCexLedger: false,
    hasStatementEvidence: false,
    hasWalletEvidence: false,
    ...fields,
  };
}

describe('findAccountInputFacts', () => {
  test('reads wallet, credential and statement evidence', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const wallet = await makeWallet(tx, user.id, false);
      const onChain = await seedAccount(tx, user.id, 'blockchain', {
        chainId: 1,
        userWalletId: wallet.id,
      });
      await ledgerRow(tx, onChain, 'etherscan');

      const exchange = await seedAccount(tx, user.id, 'sync_exchange_balances');
      const credential = await makeCredential(tx, {
        userId: user.id,
        institutionId: exchange.institution.id,
      });
      await ledgerRow(tx, exchange, 'kraken-api');

      const imported = await seedAccount(tx, user.id, 'import_wise');
      const cexLedgerOnly = await seedAccount(tx, user.id, 'manual');
      await ledgerRow(tx, cexLedgerOnly, 'binance-api');

      const statementRows = await seedAccount(tx, user.id, 'manual');
      await ledgerRow(tx, statementRows, 'statement-csv');
      const statementClose = await seedAccount(tx, user.id, 'manual');
      await observation(tx, statementClose, 'statement-close');

      const chainRowsOnly = await seedAccount(tx, user.id, 'manual');
      await ledgerRow(tx, chainRowsOnly, 'solana');

      const typed = await seedAccount(tx, user.id, 'manual');
      await ledgerRow(tx, typed, 'user-entered');
      await observation(tx, typed, 'sync-capture');

      const stranger = await makeUser(tx);
      await seedAccount(tx, stranger.id, 'sync_exchange_balances');

      const found = await repo().findAccountInputFacts(user.id, tx);

      expect(found.toSorted(byAccount)).toEqual(
        [
          facts(onChain, {
            chainId: '1',
            walletId: wallet.id,
            walletActive: false,
            hasWalletEvidence: true,
          }),
          facts(exchange, {
            credentialId: credential.id,
            credentialActive: true,
            hasProviderHoldings: true,
            hasCexLedger: true,
          }),
          facts(imported, { hasProviderHoldings: true }),
          facts(cexLedgerOnly, { hasCexLedger: true }),
          facts(statementRows, { hasStatementEvidence: true }),
          facts(statementClose, { hasStatementEvidence: true }),
          facts(chainRowsOnly, { hasWalletEvidence: true }),
          facts(typed),
        ].toSorted(byAccount)
      );
    });
  });

  test("a wallet pointer is followed only to the owner's wallet, and a malformed one is ignored", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const stranger = await makeUser(tx);
      const own = await makeWallet(tx, user.id, true);
      const theirs = await makeWallet(tx, stranger.id, true);
      const linked = await seedAccount(tx, user.id, 'blockchain', { userWalletId: own.id });
      const crossed = await seedAccount(tx, user.id, 'blockchain', { userWalletId: theirs.id });
      const malformed = await seedAccount(tx, user.id, 'blockchain', {
        chainId: '-2',
        userWalletId: 'not-a-uuid',
      });

      const found = await repo().findAccountInputFacts(user.id, tx);

      expect(found.toSorted(byAccount)).toEqual(
        [
          facts(linked, { walletId: own.id, walletActive: true, hasWalletEvidence: true }),
          facts(crossed, { hasWalletEvidence: true }),
          facts(malformed, { chainId: '-2', hasWalletEvidence: true }),
        ].toSorted(byAccount)
      );
    });
  });
});

describe('insertMissing', () => {
  test('is idempotent', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const wallet = await makeWallet(tx, user.id, true);
      const { account } = await seedAccount(tx, user.id, 'blockchain', { userWalletId: wallet.id });
      const planned = (
        source: string,
        fields: Partial<PlannedFeedInput> = {}
      ): PlannedFeedInput => ({
        userId: user.id,
        accountId: account.id,
        source,
        credentialId: null,
        walletId: null,
        status: 'active',
        ...fields,
      });
      const both = [planned('etherscan', { walletId: wallet.id }), planned('statement')];

      expect(await repo().insertMissing(both, tx)).toBe(2);
      expect(await repo().insertMissing(both, tx)).toBe(0);
      expect(
        await repo().insertMissing([...both, planned('kraken-api', { status: 'disconnected' })], tx)
      ).toBe(1);
      expect(await repo().insertMissing([], tx)).toBe(0);

      const stored = await tx
        .select({
          source: schema.feedInputs.source,
          walletId: schema.feedInputs.walletId,
          credentialId: schema.feedInputs.credentialId,
          status: schema.feedInputs.status,
        })
        .from(schema.feedInputs)
        .where(eq(schema.feedInputs.accountId, account.id));
      expect(stored.toSorted((a, b) => a.source.localeCompare(b.source))).toEqual([
        { source: 'etherscan', walletId: wallet.id, credentialId: null, status: 'active' },
        { source: 'kraken-api', walletId: null, credentialId: null, status: 'disconnected' },
        { source: 'statement', walletId: null, credentialId: null, status: 'active' },
      ]);
    });
  });
});

describe('findByUser', () => {
  test("returns the user's inputs and no one else's", async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const stranger = await makeUser(tx);
      const own = await seedAccount(tx, user.id, 'manual');
      const theirs = await seedAccount(tx, stranger.id, 'manual');
      const input = (seeded: Seeded, source: string): PlannedFeedInput => ({
        userId: seeded.account.userId,
        accountId: seeded.account.id,
        source,
        credentialId: null,
        walletId: null,
        status: 'active',
      });
      await repo().insertMissing(
        [input(own, 'statement'), input(own, 'etherscan'), input(theirs, 'statement')],
        tx
      );

      const found = await repo().findByUser(user.id, tx);

      expect(found.map((i) => [i.accountId, i.source])).toEqual([
        [own.account.id, 'etherscan'],
        [own.account.id, 'statement'],
      ]);
      expect(await repo().findByUser(randomUUID(), tx)).toEqual([]);
    });
  });
});
