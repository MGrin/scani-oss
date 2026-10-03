import { getDb } from '@scani/db';
import { sql } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import {
  FeedInputRepository,
  type InputAccountScope,
} from '../../repositories/FeedInputRepository';
import { BaseService } from '../BaseService';
import {
  type AccountInputFacts,
  planFeedInputs,
  planInputConnections,
} from '../foundation/plan-feed-inputs';

/**
 * Keeps an account's feed inputs current with the credential or wallet behind
 * them (D-11), after a connect, a disconnect, or an import that created the
 * account. For each account in scope it creates the inputs D-7 plans
 * (`planFeedInputs`, the backfill's own rule), links the ones that exist to
 * their credential or wallet where they carry none (R39), and gives them the
 * status that connection gives: `active`, or `disconnected`.
 *
 * Bookkeeping, so it never fails its caller: connecting is what the person
 * asked for, and a failure is logged per account while the others go on.
 * Each account is its own transaction and holds only that account's inputs,
 * so it cannot wait on an import while holding what the import needs (N2).
 * It also holds the account's credential FOR SHARE, which no import takes
 * inside a transaction: every write of that row is one statement of its own,
 * so at worst one waits for this account's follow to end.
 */
@Service()
export class FeedInputFollower extends BaseService {
  private readonly inputs = Container.get(FeedInputRepository);

  constructor() {
    super('FeedInputFollower');
  }

  async follow(userId: string, scope: InputAccountScope): Promise<void> {
    let accounts: AccountInputFacts[];
    try {
      accounts = await this.inputs.findAccountInputFacts(userId, undefined, scope);
    } catch (error) {
      this.logWarning('Could not read the accounts whose feed inputs follow', {
        userId,
        scope,
        error: error instanceof Error ? error.message : String(error),
        pgCode: pgCodeOf(error),
      });
      return;
    }
    for (const account of accounts) {
      try {
        await getDb().transaction(async (tx) => {
          // Connect and an account's removal run this inside the request, and
          // an ingest holds its input FOR NO KEY UPDATE for the whole run (N2):
          // give up on the account after 5s, the foundation migrations' bound,
          // rather than hold the person behind statement_timeout.
          await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
          // A credential goes back to active on a reconnect (SC-1534), so the
          // status written here must not come from the read above: a connect
          // and a disconnect in flight together would leave whichever follow
          // wrote last, not whichever change did. Lock the credential, then
          // read the account again.
          await this.inputs.lockCredentialOf(userId, account.accountId, tx);
          const [current] = await this.inputs.findAccountInputFacts(userId, tx, {
            accountIds: [account.accountId],
          });
          if (!current) return;
          await this.inputs.insertMissing(planFeedInputs(current), tx);
          await this.inputs.linkAndSetStatus(planInputConnections(current), tx);
        });
      } catch (error) {
        this.logWarning('Could not bring an account’s feed inputs up to its connection', {
          userId,
          accountId: account.accountId,
          error: error instanceof Error ? error.message : String(error),
          pgCode: pgCodeOf(error),
        });
      }
    }
  }
}

// Drizzle keeps the SQLSTATE on the error or on its `cause`, and its message
// alone cannot tell a lock timeout (55P03) from any other failure.
function pgCodeOf(error: unknown): unknown {
  const pg = error as { code?: unknown; cause?: { code?: unknown } } | null;
  return pg?.code ?? pg?.cause?.code;
}
