import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type {
  NewRecurringSuggestionDismissal,
  RecurringSuggestionDismissal,
} from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { eq } from 'drizzle-orm';
import { Service } from 'typedi';

/** One key per payee and currency, as `RecurringSuggestionService` compares them. */
export const dismissalKey = (counterpartyKey: string, currencyTokenId: string) =>
  JSON.stringify([counterpartyKey, currencyTokenId]);

// The recurring-payment suggestions a user said no to (SC-674).
@Service()
export class RecurringSuggestionDismissalRepository extends BaseRepository<
  RecurringSuggestionDismissal,
  NewRecurringSuggestionDismissal
> {
  protected readonly table = schema.recurringSuggestionDismissals;
  protected readonly tableName = 'recurring_suggestion_dismissals';

  /** Idempotent: dismissing twice is one dismissal. */
  async dismiss(
    userId: string,
    counterpartyKey: string,
    currencyTokenId: string,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    await this.getDb(transaction)
      .insert(schema.recurringSuggestionDismissals)
      .values({ userId, counterpartyKey, currencyTokenId })
      .onConflictDoNothing();
  }

  async keysForUser(userId: string, transaction?: DatabaseTransaction): Promise<Set<string>> {
    const rows = await this.getDb(transaction)
      .select({
        counterpartyKey: schema.recurringSuggestionDismissals.counterpartyKey,
        currencyTokenId: schema.recurringSuggestionDismissals.currencyTokenId,
      })
      .from(schema.recurringSuggestionDismissals)
      .where(eq(schema.recurringSuggestionDismissals.userId, userId));
    return new Set(rows.map((r) => dismissalKey(r.counterpartyKey, r.currencyTokenId)));
  }
}
