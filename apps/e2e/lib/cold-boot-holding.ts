import type * as schema from '@scani/db/schema';

/**
 * One holding of the cold-boot portfolio (`scripts/seed-cold-boot.ts`).
 *
 * A number a person keeps, with no ledger row and no observation behind it. So
 * it is a snapshot holding, and it starts when it is created: what the
 * foundation classifier derives for a row with no evidence. The seed inserts
 * directly, and no writer comes after it to fill either column.
 */
export function coldBootHolding(input: {
  userId: string;
  accountId: string;
  tokenId: string;
  index: number;
  at: Date;
}): typeof schema.holdings.$inferInsert {
  return {
    userId: input.userId,
    accountId: input.accountId,
    tokenId: input.tokenId,
    balance: String(10 + input.index),
    source: 'manual',
    kind: 'snapshot',
    createdAt: input.at,
    startsAt: input.at,
  };
}
