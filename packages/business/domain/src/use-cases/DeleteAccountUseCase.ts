import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { createComponentLogger } from '@scani/logging';
import { eq, inArray } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { Container, Service } from 'typedi';
import { pendingSignInIds } from '../lib/pending-sign-in';
import { DeleteAllUserDataUseCase } from './DeleteAllUserDataUseCase';

const logger = createComponentLogger('use-case:delete-account');

/**
 * Removes the account itself: everything `DeleteAllUserDataUseCase` removes,
 * then the login, the sessions, any pending sign-in links and the `users` row,
 * in ONE transaction (SC-1260). That use case keeps the login on purpose — the
 * settings copy promises an emptied account you can still sign in to — so it
 * cannot answer a request to erase the account, and this is the path that can.
 *
 * Object-store and queue purges follow the commit, for the reason the data use
 * case gives: neither can join the transaction, and bytes with no row are the
 * recoverable failure where rows pointing at deleted bytes are not.
 */
@Service()
export class DeleteAccountUseCase {
  private readonly data = Container.get(DeleteAllUserDataUseCase);

  async execute(userId: string): Promise<{ deleted: boolean }> {
    let echoed = new Map<PgTable, string[]>();

    const deleted = await withTransaction(
      async (tx) => {
        const [user] = await tx
          .select({ email: schema.users.email })
          .from(schema.users)
          .where(eq(schema.users.id, userId));
        if (!user) return false;

        // `token_price_edit_history` attributes a GLOBAL price change and its FK
        // is ON DELETE RESTRICT. Refusing here, before anything is touched, says
        // why; the FK alone would fail the final delete with a constraint name.
        const [edit] = await tx
          .select({ id: schema.tokenPriceEditHistory.id })
          .from(schema.tokenPriceEditHistory)
          .where(eq(schema.tokenPriceEditHistory.editedByUserId, userId))
          .limit(1);
        if (edit) {
          throw new Error(
            `Account ${userId} edited a global token price; its attribution is kept, so the account cannot be deleted`
          );
        }

        echoed = await this.data.deleteRows(tx, userId);

        await tx.delete(schema.userSessions).where(eq(schema.userSessions.userId, userId));
        await tx.delete(schema.userAccounts).where(eq(schema.userAccounts.userId, userId));
        await tx
          .delete(schema.userVerifications)
          .where(
            inArray(
              schema.userVerifications.id,
              pendingSignInIds(tx, schema.userVerifications, user.email)
            )
          );
        await tx.delete(schema.users).where(eq(schema.users.id, userId));
        return true;
      },
      { name: 'deleteAccount', timeout: 30000 }
    );

    if (!deleted) return { deleted: false };
    await this.data.purgeAfterCommit(userId, echoed);
    logger.warn({ userId }, 'Account deleted');
    return { deleted: true };
  }
}
