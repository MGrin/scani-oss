import { BaseRepository, type DatabaseTransaction } from '@scani/db';
import type { Institution, NewInstitution } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, ne, sql } from 'drizzle-orm';
import { Service } from 'typedi';

export type StaleSyncTarget = {
  credentialId: string;
  userId: string;
  institutionId: string;
  institutionName: string;
  /**
   * `orphaned-credential` — the credential has no active account, so the
   * scheduled sync skips it before reading it and can never create one.
   * `stale-account` — it has accounts and every one is older than the cutoff.
   */
  kind: 'stale-account' | 'orphaned-credential';
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
      select uic.id as credential_id, uic.user_id, i.id as institution_id, i.name as institution_name,
        case when count(a.id) = 0 then 'orphaned-credential'
             else 'stale-account' end as kind
      from user_integration_credentials uic
      join institutions i on i.id = uic.institution_id
      join institution_types it on it.id = i.type_id
      left join accounts a
        on a.institution_id = uic.institution_id
       and a.user_id = uic.user_id
       and a.is_active
      where it.code <> 'crypto_wallet'
        and uic.is_active
      group by uic.id, uic.user_id, i.id, i.name
      having
        -- orphaned-credential: no active account, which the sync treats as
        -- "nothing to do" — it returns before it ever reads the credential
        -- (SyncExchangeBalancesUseCase), and account creation lives only in
        -- the user-initiated import. So this state cannot recover on its own
        -- and is never healthy.
        --
        -- It used to be guarded by bool_or(import_status <> 'enqueued') on
        -- the theory that a successfully-imported-but-empty exchange lands
        -- here. It does not: IntegrationImportService.resolveAccountRow
        -- creates the account row BEFORE skipZeroBalances is consulted, and
        -- an import that discovers no accounts throws instead. Measured on
        -- production 2026-08-16 — an Airwallex import with tokensImported: 0
        -- still recorded accountsCreated: 1 and still syncs hourly. An empty
        -- exchange therefore has an account and is judged by the freshness
        -- branch below; it still does not page. The guard was silencing the
        -- fault it was named after (SC-248).
        count(a.id) = 0
        -- stale-account: has accounts, but every one last synced before the
        -- cutoff. The 'epoch' coalesce makes an account that has never synced
        -- at all count as infinitely stale rather than as unknown.
        or bool_and(coalesce((a.metadata->>'lastSync')::timestamptz, 'epoch') < ${cutoff.toISOString()}::timestamptz)
    `)) as unknown as Array<{
      credential_id: string;
      user_id: string;
      institution_id: string;
      institution_name: string;
      kind: 'stale-account' | 'orphaned-credential';
    }>;
    return rows.map((r) => ({
      credentialId: r.credential_id,
      userId: r.user_id,
      institutionId: r.institution_id,
      institutionName: r.institution_name,
      kind: r.kind,
    }));
  }

  /**
   * An active institution whose name matches, ignoring case and
   * surrounding whitespace.
   *
   * `institutions` is a shared catalogue with no uniqueness on `name`, so
   * the import flow's "Add <name>" happily inserted a second row next to
   * the seeded one. The user then saw two identical picker rows, chose the
   * empty one, and was told their account did not exist (SC-135).
   *
   * Ordered by `created_at` so the seeded catalogue row — the one every
   * other user's data already hangs off — wins over any later duplicate.
   */
  async findByNameInsensitive(
    name: string,
    transaction?: DatabaseTransaction
  ): Promise<Institution | null> {
    const database = this.getDb(transaction);
    const [row] = await database
      .select()
      .from(schema.institutions)
      .where(
        and(
          sql`lower(trim(${schema.institutions.name})) = lower(trim(${name}))`,
          eq(schema.institutions.isActive, true)
        )
      )
      .orderBy(schema.institutions.createdAt)
      .limit(1);
    return row ?? null;
  }

  /**
   * Institutions the hourly BALANCE sync owns.
   *
   * Capability/type driven: any institution a user connected (has a
   * credential) that isn't a blockchain wallet. Replaces the old hardcoded
   * display-name list that silently dropped renamed/new providers (IBKR,
   * Airwallex).
   *
   * Blockchain wallets are excluded because their BALANCES are refreshed by
   * the `wallet-balances` job — and only their balances. Reading that
   * exclusion as "wallets are covered elsewhere, full stop" is what kept
   * every wallet's transaction LEDGER frozen at its import for as long as
   * the wallet existed (SC-360). The transaction sync must therefore NOT
   * use this method; it uses `findTransactionSyncableInstitutions` below.
   */
  async findSyncableInstitutions(transaction?: DatabaseTransaction): Promise<Institution[]> {
    return this.findCredentialedInstitutions(false, transaction);
  }

  /**
   * Institutions the daily TRANSACTION sync owns — the same set plus
   * blockchain wallets, which have no other path back to their ledger.
   */
  async findTransactionSyncableInstitutions(
    transaction?: DatabaseTransaction
  ): Promise<Institution[]> {
    return this.findCredentialedInstitutions(true, transaction);
  }

  private async findCredentialedInstitutions(
    includeWallets: boolean,
    transaction?: DatabaseTransaction
  ): Promise<Institution[]> {
    const database = this.getDb(transaction);
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
      .where(
        and(
          includeWallets ? undefined : ne(schema.institutionTypes.code, 'crypto_wallet'),
          // A soft-deleted credential (AccountService removes the last
          // account → IntegrationCredentialsService.deleteCredentials) is
          // not a connection any more, so it must not keep its institution
          // in the hourly sync loop.
          eq(schema.userIntegrationCredentials.isActive, true)
        )
      );
    return rows.map((r) => r.institution);
  }
}
