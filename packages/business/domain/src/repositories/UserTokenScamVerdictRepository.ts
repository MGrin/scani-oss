import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { NewUserTokenScamVerdict, UserTokenScamVerdict } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq } from 'drizzle-orm';
import { Service } from 'typedi';

export type ScamVerdict = UserTokenScamVerdict['verdict'];

// One user's own scam verdicts (SC-1160). Writes here change what THAT user
// sees and nothing else — see the `user_token_scam_verdicts` table comment and
// `lib/scam-verdict.ts`, which is where they are read.
@Service()
export class UserTokenScamVerdictRepository extends BaseRepository<
  UserTokenScamVerdict,
  NewUserTokenScamVerdict
> {
  protected readonly table = schema.userTokenScamVerdicts;
  protected readonly tableName = 'user_token_scam_verdicts';

  /** Record or replace this user's verdict on the token. */
  async setVerdict(
    userId: string,
    tokenId: string,
    verdict: ScamVerdict,
    transaction?: DatabaseTransaction
  ): Promise<void> {
    const database = this.getDb(transaction);
    const now = new Date();
    await database
      .insert(schema.userTokenScamVerdicts)
      .values({ userId, tokenId, verdict, source: 'user', createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [schema.userTokenScamVerdicts.userId, schema.userTokenScamVerdicts.tokenId],
        set: { verdict, source: 'user', updatedAt: now },
      });
  }

  async findVerdict(
    userId: string,
    tokenId: string,
    transaction?: DatabaseTransaction
  ): Promise<ScamVerdict | null> {
    const database = this.getDb(transaction);
    const [row] = await database
      .select({ verdict: schema.userTokenScamVerdicts.verdict })
      .from(schema.userTokenScamVerdicts)
      .where(
        and(
          eq(schema.userTokenScamVerdicts.userId, userId),
          eq(schema.userTokenScamVerdicts.tokenId, tokenId)
        )
      )
      .limit(1);
    return row?.verdict ?? null;
  }
}
