import { cached } from '../../cache';
import { type Result, tryCatch } from '../../result';
import { getSql } from './sql';

export interface IntegrationStats {
  userIntegrationCredentials: number;
  institutions: number;
  integrationsByInstitution: Array<{ institution: string; count: number }>;
  topInstitutions: Array<{ institution: string; accounts: number }>;
  /**
   * Import-pipeline state breakdown for `user_integration_credentials`.
   * Surfaces stragglers stuck in `pending_enqueue` / `enqueued` and the
   * total of explicitly-failed imports.
   */
  importStatus: Array<{ status: string; count: number }>;
  /**
   * Credentials with `import_status = 'failed'` and the most recent
   * `import_last_error` (top 10).
   */
  recentFailedImports: Array<{
    id: string;
    institution: string;
    retryCount: number;
    lastError: string | null;
    updatedAt: string;
  }>;
  /**
   * Credentials stuck in `pending_enqueue` for longer than the reconciler
   * window (5 minutes). These point at the orphan-reconciler not picking
   * them up.
   */
  stuckPending: number;
}

interface CountsRow {
  user_integration_credentials: string;
  institutions: string;
  stuck_pending: string;
}

export async function getIntegrationStats(): Promise<Result<IntegrationStats>> {
  return tryCatch(() =>
    cached('app-db:integration-stats', 60, async () => {
      const db = await getSql();
      const [
        countsRow,
        integrationsByInstitutionRows,
        topInstitutionsRows,
        importStatusRows,
        recentFailedRows,
      ] = (await Promise.all([
        db`
          SELECT
            (SELECT count(*) FROM user_integration_credentials)::text AS user_integration_credentials,
            (SELECT count(*) FROM institutions)::text AS institutions,
            (SELECT count(*) FROM user_integration_credentials
              WHERE import_status = 'pending_enqueue'
                AND import_enqueued_at < now() - interval '5 minutes'
            )::text AS stuck_pending
        `,
        db`
          SELECT i.name AS institution, count(uic.id)::text AS count
          FROM user_integration_credentials uic
          JOIN institutions i ON i.id = uic.institution_id
          GROUP BY i.name
          ORDER BY count(uic.id) DESC
          LIMIT 20
        `,
        db`
          SELECT i.name AS institution, count(a.id)::text AS accounts
          FROM accounts a
          JOIN institutions i ON i.id = a.institution_id
          GROUP BY i.name
          ORDER BY count(a.id) DESC
          LIMIT 20
        `,
        db`
          SELECT import_status AS status, count(*)::text AS count
          FROM user_integration_credentials
          WHERE import_status IS NOT NULL
          GROUP BY import_status
          ORDER BY count(*) DESC
        `,
        db`
          SELECT
            uic.id::text,
            i.name AS institution,
            uic.import_retry_count AS retry_count,
            uic.import_last_error AS last_error,
            uic.updated_at::text
          FROM user_integration_credentials uic
          JOIN institutions i ON i.id = uic.institution_id
          WHERE uic.import_status = 'failed'
          ORDER BY uic.updated_at DESC
          LIMIT 10
        `,
      ])) as [
        CountsRow[],
        Array<{ institution: string; count: string }>,
        Array<{ institution: string; accounts: string }>,
        Array<{ status: string; count: string }>,
        Array<{
          id: string;
          institution: string;
          retry_count: number | null;
          last_error: string | null;
          updated_at: string;
        }>,
      ];

      const counts = countsRow[0];
      if (!counts) throw new Error('integration stats counts query returned empty');

      return {
        userIntegrationCredentials: Number.parseInt(counts.user_integration_credentials, 10),
        institutions: Number.parseInt(counts.institutions, 10),
        integrationsByInstitution: integrationsByInstitutionRows.map((r) => ({
          institution: r.institution,
          count: Number.parseInt(r.count, 10),
        })),
        topInstitutions: topInstitutionsRows.map((r) => ({
          institution: r.institution,
          accounts: Number.parseInt(r.accounts, 10),
        })),
        importStatus: importStatusRows.map((r) => ({
          status: r.status,
          count: Number.parseInt(r.count, 10),
        })),
        recentFailedImports: recentFailedRows.map((r) => ({
          id: r.id,
          institution: r.institution,
          retryCount: r.retry_count ?? 0,
          lastError: r.last_error,
          updatedAt: new Date(r.updated_at).toISOString(),
        })),
        stuckPending: Number.parseInt(counts.stuck_pending, 10),
      };
    })
  );
}
