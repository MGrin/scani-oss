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

  /**
   * `email` is the address the account had, for erasures that key on it
   * after the row is gone (SC-1509).
   */
  async execute(userId: string): Promise<{ deleted: boolean; email?: string }> {
    let echoed = new Map<PgTable, string[]>();
    let email: string | undefined;

    const deleted = await withTransaction(
      async (tx) => {
        const [user] = await tx
          .select({ email: schema.users.email })
          .from(schema.users)
          .where(eq(schema.users.id, userId));
        if (!user) return false;
        email = user.email;

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
    return { deleted: true, email };
  }
}
