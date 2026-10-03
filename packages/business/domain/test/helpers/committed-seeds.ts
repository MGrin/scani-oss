/**
 * Seeds for code that writes through its own connection — connect, disconnect,
 * the feed-input follower — so they are committed rather than rolled back.
 * Every row is pushed to `rows`, for `afterEach(rows.drop)`.
 */

import { type DatabaseTransaction, getDb } from '@scani/db';
import type * as schema from '@scani/db/schema';
import { providerInputSource } from '../../src/services/foundation/plan-feed-inputs';
import { EXCHANGE_BALANCE_SYNC_SOURCE } from '../../src/services/holdings/balance-sync-sources';
import type { CommittedRows } from './committed-rows';
import { makeCredential, makeInstitution, makeInstitutionType, makeUser } from './factories';
import {
  makeAccount,
  makeChainAccount,
  makeHolding,
  makeToken,
  makeWallet,
} from './factories-extra';

type Account = typeof schema.accounts.$inferSelect;

interface Owner {
  userId: string;
  institutionId: string;
  institutionName: string;
}

/** The seeded type is upserted, so no `institution_types` row outlives the test. */
async function ownerIn(
  tx: DatabaseTransaction,
  rows: CommittedRows,
  typeCode: 'crypto_exchange' | 'crypto_wallet'
): Promise<Owner> {
  const user = await makeUser(tx);
  const type = await makeInstitutionType(tx, { code: typeCode });
  const institution = await makeInstitution(tx, { typeId: type.id });
  rows.users.push(user.id);
  rows.institutions.push(institution.id);
  return { userId: user.id, institutionId: institution.id, institutionName: institution.name };
}

/** A user with one chain institution and no wallet yet, committed. */
export function commitChainOwner(rows: CommittedRows): Promise<Owner> {
  return getDb().transaction((tx) => ownerIn(tx, rows, 'crypto_wallet'));
}

export interface CommittedWalletAccount {
  userId: string;
  walletId: string;
  account: Account;
}

/** A user's wallet and the account the wallet import made for one EVM chain, committed. */
export function commitWalletAccount(
  rows: CommittedRows,
  { walletActive = true }: { walletActive?: boolean } = {}
): Promise<CommittedWalletAccount> {
  return getDb().transaction(async (tx) => {
    const owner = await ownerIn(tx, rows, 'crypto_wallet');
    const wallet = await makeWallet(tx, owner, { isActive: walletActive });
    const account = await makeChainAccount(tx, owner, wallet.id);
    return { userId: owner.userId, walletId: wallet.id, account };
  });
}

export interface CommittedExchange {
  userId: string;
  institutionId: string;
  /** The source D-7 names each account's provider input by. */
  source: string;
  /** The user's credential at the exchange, when seeded `connected`. */
  credentialId: string | null;
  /** The accounts there, ordered by id. */
  accounts: Account[];
  /** The first of them, for a test that needs one. */
  account: Account;
}

/**
 * A user's accounts at one exchange, committed. With `evidence`, each holds
 * what the exchange sync writes, so D-7 plans its provider input; without, it
 * holds nothing, as after a run that fetched nothing. With `connected`, the
 * user's credential there exists already.
 */
export function commitExchange(
  rows: CommittedRows,
  {
    accounts = 1,
    evidence = false,
    connected = false,
  }: { accounts?: number; evidence?: boolean; connected?: boolean } = {}
): Promise<CommittedExchange> {
  return getDb().transaction(async (tx) => {
    const owner = await ownerIn(tx, rows, 'crypto_exchange');
    const credential = connected
      ? await makeCredential(tx, { userId: owner.userId, institutionId: owner.institutionId })
      : null;
    const made: Account[] = [];
    for (let i = 0; i < accounts; i += 1) {
      const account = await makeAccount(tx, {
        userId: owner.userId,
        institutionId: owner.institutionId,
      });
      if (evidence) {
        const token = await makeToken(tx);
        rows.tokens.push(token.id);
        await makeHolding(tx, {
          userId: owner.userId,
          accountId: account.id,
          tokenId: token.id,
          source: EXCHANGE_BALANCE_SYNC_SOURCE,
        });
      }
      made.push(account);
    }
    made.sort((a, b) => (a.id < b.id ? -1 : 1));
    return {
      userId: owner.userId,
      institutionId: owner.institutionId,
      source: providerInputSource(owner.institutionName),
      credentialId: credential?.id ?? null,
      accounts: made,
      account: made[0]!,
    };
  });
}
