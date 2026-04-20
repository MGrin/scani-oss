import { neon } from '@neondatabase/serverless';
import { cached } from '../cache';
import { type Result, tryCatch } from '../result';
import { getDatabaseUrl } from './neon';

type Sql = ReturnType<typeof neon>;
let sql: Sql | null = null;

async function getSql(): Promise<Sql> {
  if (sql) return sql;
  const url = await getDatabaseUrl();
  sql = neon(url);
  return sql;
}

export interface AppDbStats {
  users: number;
  activeSessions: number;
  vaults: number;
  accounts: number;
  holdings: number;
  tokens: number;
  tokenPrices: number;
  institutions: number;
  userWallets: number;
  userIntegrationCredentials: number;
  tokenPricesFreshestAt: string | null;
  integrationsByInstitution: Array<{ institution: string; count: number }>;
  topInstitutions: Array<{ institution: string; accounts: number }>;
  dbSizeBytes: number;
  dbSizePretty: string;
}

interface CountsRow {
  users: string;
  active_sessions: string;
  vaults: string;
  accounts: string;
  holdings: string;
  tokens: string;
  token_prices: string;
  institutions: string;
  user_wallets: string;
  user_integration_credentials: string;
}

export async function getAppDbStats(): Promise<Result<AppDbStats>> {
  return tryCatch(() =>
    cached('app-db:stats', 60, async () => {
      const db = await getSql();

      const [countsRow, freshestRow, integrationsRows, topInstitutionsRows, sizeRow] =
        (await Promise.all([
          db`
          SELECT
            (SELECT count(*) FROM users)::text as users,
            (SELECT count(*) FROM user_sessions WHERE expires_at > now())::text as active_sessions,
            (SELECT count(*) FROM vaults)::text as vaults,
            (SELECT count(*) FROM accounts)::text as accounts,
            (SELECT count(*) FROM holdings)::text as holdings,
            (SELECT count(*) FROM tokens)::text as tokens,
            (SELECT count(*) FROM token_prices)::text as token_prices,
            (SELECT count(*) FROM institutions)::text as institutions,
            (SELECT count(*) FROM user_wallets)::text as user_wallets,
            (SELECT count(*) FROM user_integration_credentials)::text as user_integration_credentials
        `,
          db`SELECT max(timestamp) as freshest FROM token_prices`,
          db`
          SELECT i.name as institution, count(uic.id)::text as count
          FROM user_integration_credentials uic
          JOIN institutions i ON i.id = uic.institution_id
          GROUP BY i.name
          ORDER BY count(uic.id) DESC
          LIMIT 20
        `,
          db`
          SELECT i.name as institution, count(a.id)::text as accounts
          FROM accounts a
          JOIN institutions i ON i.id = a.institution_id
          GROUP BY i.name
          ORDER BY count(a.id) DESC
          LIMIT 20
        `,
          db`
          SELECT pg_database_size(current_database())::text as bytes,
                 pg_size_pretty(pg_database_size(current_database())) as pretty
        `,
        ])) as [
          CountsRow[],
          Array<{ freshest: string | null }>,
          Array<{ institution: string; count: string }>,
          Array<{ institution: string; accounts: string }>,
          Array<{ bytes: string; pretty: string }>,
        ];

      const counts = countsRow[0];
      const freshest = freshestRow[0];
      const size = sizeRow[0];
      if (!counts || !freshest || !size) throw new Error('DB stats query returned empty rows');

      return {
        users: Number.parseInt(counts.users, 10),
        activeSessions: Number.parseInt(counts.active_sessions, 10),
        vaults: Number.parseInt(counts.vaults, 10),
        accounts: Number.parseInt(counts.accounts, 10),
        holdings: Number.parseInt(counts.holdings, 10),
        tokens: Number.parseInt(counts.tokens, 10),
        tokenPrices: Number.parseInt(counts.token_prices, 10),
        institutions: Number.parseInt(counts.institutions, 10),
        userWallets: Number.parseInt(counts.user_wallets, 10),
        userIntegrationCredentials: Number.parseInt(counts.user_integration_credentials, 10),
        tokenPricesFreshestAt: freshest.freshest ? new Date(freshest.freshest).toISOString() : null,
        integrationsByInstitution: integrationsRows.map((r) => ({
          institution: r.institution,
          count: Number.parseInt(r.count, 10),
        })),
        topInstitutions: topInstitutionsRows.map((r) => ({
          institution: r.institution,
          accounts: Number.parseInt(r.accounts, 10),
        })),
        dbSizeBytes: Number.parseInt(size.bytes, 10),
        dbSizePretty: size.pretty,
      };
    })
  );
}
