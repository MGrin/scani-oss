import type * as schema from '@scani/db/schema';

/**
 * One holding of the cold-boot portfolio (`scripts/seed-cold-boot.ts`).
 *
 * A number a person keeps, with no ledger row behind it. So it is a snapshot
 * holding, and it starts when it is created: what the foundation classifier
 * derives for a row like it. The seed inserts it directly, and no writer comes
 * after it to fill either column. It is inserted unfunded: the person's value
 * is a reading, and the calculator funds the holding from it (A5 D-4).
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
    balance: '0',
    source: 'manual',
    kind: 'snapshot',
    createdAt: input.at,
    startsAt: input.at,
  };
}

/** The value a person records for the cold-boot holding at `index`. */
export function coldBootBalance(index: number): string {
  return String(10 + index);
}
