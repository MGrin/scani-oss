import type { DatabaseTransaction } from '@scani/db';
import { getDb } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';

export type AccountClass = 'asset' | 'liability';

/** A balance below zero anywhere but fiat owed on a liability account. */
export class NegativeBalanceRefused extends Error {
  constructor(readonly balance: string) {
    super(`A balance of ${balance} is below zero, and only a loan or card account can owe`);
    this.name = 'NegativeBalanceRefused';
  }
}

/**
 * SC-1640. The ONE place an account's class is read, so the rule that lets a
 * liability account hold a negative balance cannot drift between callers.
 */
@Service()
export class AccountClassService {
  /** null when the account does not exist or is not this user's. */
  async classOf(
    userId: string,
    accountId: string,
    tx?: DatabaseTransaction
  ): Promise<AccountClass | null> {
    const [row] = await (tx ?? getDb())
      .select({ class: schema.accountTypes.class })
      .from(schema.accounts)
      .innerJoin(schema.accountTypes, eq(schema.accounts.typeId, schema.accountTypes.id))
      .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, userId)));
    return row?.class ?? null;
  }

  async typeCodeOf(
    userId: string,
    accountId: string,
    tx?: DatabaseTransaction
  ): Promise<string | null> {
    const [row] = await (tx ?? getDb())
      .select({ code: schema.accountTypes.code })
      .from(schema.accounts)
      .innerJoin(schema.accountTypes, eq(schema.accounts.typeId, schema.accountTypes.id))
      .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.userId, userId)));
    return row?.code ?? null;
  }

  async isLiability(userId: string, accountId: string, tx?: DatabaseTransaction): Promise<boolean> {
    return (await this.classOf(userId, accountId, tx)) === 'liability';
  }

  /**
   * Whether this holding may sit below zero: fiat on a liability account,
   * which is what a loan or card owes. Anything else below zero is a mistake.
   */
  async holdingMayOwe(
    userId: string,
    holdingId: string,
    tx?: DatabaseTransaction
  ): Promise<boolean> {
    const [row] = await (tx ?? getDb())
      .select({ accountClass: schema.accountTypes.class, tokenType: schema.tokenTypes.code })
      .from(schema.holdings)
      .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
      .innerJoin(schema.accountTypes, eq(schema.accountTypes.id, schema.accounts.typeId))
      .innerJoin(schema.tokens, eq(schema.tokens.id, schema.holdings.tokenId))
      .innerJoin(schema.tokenTypes, eq(schema.tokenTypes.id, schema.tokens.typeId))
      .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, userId)));
    return row?.accountClass === 'liability' && row.tokenType === 'fiat';
  }

  /**
   * The person's own edit may not leave a holding below zero unless it owes.
   * Only the edit: undoing a transfer (SC-618) and an inflow into margin cash
   * write a negative through `UpdateHoldingUseCase` on purpose.
   */
  async refuseNegativeEdit(
    userId: string,
    holdingId: string,
    balance: string,
    tx?: DatabaseTransaction
  ): Promise<void> {
    if (!new Decimal(balance).isNegative()) return;
    if (await this.holdingMayOwe(userId, holdingId, tx)) return;
    throw new NegativeBalanceRefused(balance);
  }
}
