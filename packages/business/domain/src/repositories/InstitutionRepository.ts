import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { Institution, NewInstitution } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, ne, sql } from 'drizzle-orm';
import { Service } from 'typedi';

export type StaleSyncTarget = {
  institutionId: string;
  institutionName: string;
  kind: 'stale-account' | 'no-account';
};

@Service()
export class InstitutionRepository extends BaseRepository<Institution, NewInstitution> {
  protected readonly table = schema.institutions;
  protected readonly tableName = 'institutions';

  async findByUserId(userId: string, transaction?: DatabaseTransaction): Promise<Institution[]> {
    try {
      const database = this.getDb(transaction);
      const results = await database
        .selectDistinct({
          institution: schema.institutions,
          type: schema.institutionTypes.code,
          typeName: schema.institutionTypes.name,
        })
        .from(schema.institutions)
        .leftJoin(
          schema.institutionTypes,
          eq(schema.institutions.typeId, schema.institutionTypes.id)
        )
        .innerJoin(schema.accounts, eq(schema.accounts.institutionId, schema.institutions.id))
        .where(
          and(
            eq(schema.accounts.userId, userId),
            eq(schema.accounts.isActive, true),
            // Must match `AccountRepository.findByUser`, which excludes hidden
            // accounts — otherwise an institution whose only accounts are
            // hidden shows up on the list with an `accountCount: 0` summary,
            // because the service counts come from `findByUser` but the
            // institution visibility comes from here.
            eq(schema.accounts.isHidden, false),
            eq(schema.institutions.isActive, true)
          )
        )
        .orderBy(schema.institutions.name);

      return results.map((r) => ({
        ...r.institution,
        type: r.type,
        typeName: r.typeName,
      }));
    } catch (error) {
      this.logger.error({ userId, error }, 'Failed to find institutions by user');
      throw error;
    }
  }

  async findStaleSyncTargets(
    cutoff: Date,
    transaction?: DatabaseTransaction
  ): Promise<StaleSyncTarget[]> {
    const database = this.getDb(transaction);
    const rows = (await database.execute(sql`
      select i.id as institution_id, i.name as institution_name,
        case when count(a.id) = 0 then 'no-account'
             else 'stale-account' end as kind
      from institutions i
      join institution_types it on it.id = i.type_id
      join user_integration_credentials uic on uic.institution_id = i.id
      left join accounts a on a.institution_id = i.id and a.is_active
      where it.code <> 'crypto_wallet'
      group by i.id, i.name
      having
        -- no-account: a credentialed institution with zero accounts, but
        -- ONLY when a credential is actually in a non-healthy import state
        -- (pending_enqueue / failed). A successfully-imported-but-empty
        -- exchange (zero or dust-only balances dropped by skipZeroBalances)
        -- sits at import_status='enqueued' — the healthy terminal state,
        -- since the enum has no 'completed' value — and must NOT alert.
        -- Without this guard an empty Binance connection paged hourly forever.
        (count(a.id) = 0 and bool_or(uic.import_status <> 'enqueued'))
        -- stale-account: has accounts, but every one last synced before the
        -- cutoff. Guarded on count > 0 so the 'epoch' fallback on the single
        -- NULL row a zero-account institution produces can't masquerade as stale.
        or (count(a.id) > 0
            and bool_and(coalesce((a.metadata->>'lastSync')::timestamptz, 'epoch') < ${cutoff.toISOString()}::timestamptz))
    `)) as unknown as Array<{
      institution_id: string;
      institution_name: string;
      kind: 'stale-account' | 'no-account';
    }>;
    return rows.map((r) => ({
      institutionId: r.institution_id,
      institutionName: r.institution_name,
      kind: r.kind,
    }));
  }

  async findSyncableInstitutions(transaction?: DatabaseTransaction): Promise<Institution[]> {
    const database = this.getDb(transaction);
    // Capability/type driven: any institution a user connected (has a
    // credential) that isn't a blockchain wallet (those sync via the
    // wallet-balances job). Replaces the old hardcoded display-name list
    // that silently dropped renamed/new providers (IBKR, Airwallex).
    const rows = await database
      .selectDistinct({ institution: schema.institutions })
      .from(schema.institutions)
      .innerJoin(
        schema.institutionTypes,
        eq(schema.institutions.typeId, schema.institutionTypes.id)
      )
      .innerJoin(
        schema.userIntegrationCredentials,
        eq(schema.userIntegrationCredentials.institutionId, schema.institutions.id)
      )
      .where(ne(schema.institutionTypes.code, 'crypto_wallet'));
    return rows.map((r) => r.institution);
  }
}
