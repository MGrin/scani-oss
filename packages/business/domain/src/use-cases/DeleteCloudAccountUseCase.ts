import * as schema from '@scani/db/schema';
import { withTransaction } from '@scani/db/transaction';
import { createComponentLogger } from '@scani/logging';
import { eq, inArray } from 'drizzle-orm';
import { Service } from 'typedi';
import { pendingSignInIds } from '../lib/pending-sign-in';

const logger = createComponentLogger('use-case:delete-cloud-account');

/**
 * Removes a cloud-console account (SC-1263): its API keys, sessions, logins,
 * pending sign-in links and the `cloud_users` row, in ONE transaction.
 *
 * The cloud console is a separate auth domain from the app — `cloud_users`
 * shares no key with `users` — so `DeleteAccountUseCase` cannot reach it.
 *
 * The keys are deleted explicitly rather than left to the cascade so the
 * count is logged: a key is the one row here that authenticates on its own,
 * and "how many keys did this remove" is the question afterwards.
 *
 * `cloud_usage_events` is kept. It names the account by id in a text column,
 * with no foreign key, and it is both what billing counts and the evidence an
 * abuse investigation reads.
 */
@Service()
export class DeleteCloudAccountUseCase {
  async execute(cloudUserId: string): Promise<{ deleted: boolean }> {
    const removed = await withTransaction(
      async (tx) => {
        const [user] = await tx
          .select({ email: schema.cloudUsers.email })
          .from(schema.cloudUsers)
          .where(eq(schema.cloudUsers.id, cloudUserId));
        if (!user) return null;

        const keys = await tx
          .delete(schema.cloudApiKeys)
          .where(eq(schema.cloudApiKeys.ownerUserId, cloudUserId))
          .returning({ keyPrefix: schema.cloudApiKeys.keyPrefix });
        await tx.delete(schema.cloudSessions).where(eq(schema.cloudSessions.userId, cloudUserId));
        await tx.delete(schema.cloudAccounts).where(eq(schema.cloudAccounts.userId, cloudUserId));
        await tx
          .delete(schema.cloudVerifications)
          .where(
            inArray(
              schema.cloudVerifications.id,
              pendingSignInIds(tx, schema.cloudVerifications, user.email)
            )
          );
        await tx.delete(schema.cloudUsers).where(eq(schema.cloudUsers.id, cloudUserId));
        return keys.map((k) => k.keyPrefix);
      },
      { name: 'deleteCloudAccount', timeout: 30000 }
    );

    if (removed === null) return { deleted: false };
    logger.warn({ cloudUserId, removedKeys: removed }, 'Cloud account deleted');
    return { deleted: true };
  }
}
