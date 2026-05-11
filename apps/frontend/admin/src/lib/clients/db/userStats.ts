import { cached } from '../../cache';
import { type Result, tryCatch } from '../../result';
import { getSql } from './sql';

export interface UserStats {
  users: number;
  activeSessions: number;
  vaults: number;
  accounts: number;
  /** Users created in the last 7 / 30 days. */
  signups7d: number;
  signups30d: number;
  /** Most recent N signups (anonymized — local-part redacted). */
  recentSignups: Array<{
    id: string;
    emailMasked: string;
    createdAt: string;
  }>;
}

interface CountsRow {
  users: string;
  active_sessions: string;
  vaults: string;
  accounts: string;
  signups_7d: string;
  signups_30d: string;
}

interface RecentRow {
  id: string;
  email: string | null;
  created_at: string;
}

function maskEmail(email: string | null): string {
  if (!email) return '—';
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'•'.repeat(Math.max(1, local.length - visible.length))}${domain}`;
}

export async function getUserStats(): Promise<Result<UserStats>> {
  return tryCatch(() =>
    cached('app-db:user-stats', 60, async () => {
      const db = await getSql();
      const [countsRow, recentRows] = (await Promise.all([
        db`
          SELECT
            (SELECT count(*) FROM users)::text AS users,
            (SELECT count(*) FROM user_sessions WHERE expires_at > now())::text AS active_sessions,
            (SELECT count(*) FROM vaults)::text AS vaults,
            (SELECT count(*) FROM accounts)::text AS accounts,
            (SELECT count(*) FROM users WHERE created_at > now() - interval '7 days')::text AS signups_7d,
            (SELECT count(*) FROM users WHERE created_at > now() - interval '30 days')::text AS signups_30d
        `,
        db`
          SELECT id::text, email, created_at::text
          FROM users
          ORDER BY created_at DESC
          LIMIT 20
        `,
      ])) as [CountsRow[], RecentRow[]];

      const counts = countsRow[0];
      if (!counts) throw new Error('user stats counts query returned empty');

      return {
        users: Number.parseInt(counts.users, 10),
        activeSessions: Number.parseInt(counts.active_sessions, 10),
        vaults: Number.parseInt(counts.vaults, 10),
        accounts: Number.parseInt(counts.accounts, 10),
        signups7d: Number.parseInt(counts.signups_7d, 10),
        signups30d: Number.parseInt(counts.signups_30d, 10),
        recentSignups: recentRows.map((r) => ({
          id: r.id,
          emailMasked: maskEmail(r.email),
          createdAt: new Date(r.created_at).toISOString(),
        })),
      };
    })
  );
}
