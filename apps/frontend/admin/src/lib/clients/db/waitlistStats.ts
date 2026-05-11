import { cached } from '../../cache';
import { type Result, tryCatch } from '../../result';
import { getSql } from './sql';

export interface WaitlistEntry {
  id: string;
  emailMasked: string;
  source: string;
  referrer: string | null;
  createdAt: string;
  convertedToAccountAt: string | null;
}

export interface WaitlistStats {
  total: number;
  converted: number;
  /** `converted / total` as a 0..1 fraction; 0 when total = 0. */
  conversionRate: number;
  signups7d: number;
  signups30d: number;
  /** Signup count grouped by `source`. */
  bySource: Array<{ source: string; count: number }>;
  /** Most recent N signups, anonymized. */
  recent: WaitlistEntry[];
}

interface CountsRow {
  total: string;
  converted: string;
  signups_7d: string;
  signups_30d: string;
}

interface RecentRow {
  id: string;
  email: string;
  source: string;
  referrer: string | null;
  created_at: string;
  converted_to_account_at: string | null;
}

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'•'.repeat(Math.max(1, local.length - visible.length))}${email.slice(at)}`;
}

export async function getWaitlistStats(): Promise<Result<WaitlistStats>> {
  return tryCatch(() =>
    cached('app-db:waitlist-stats', 60, async () => {
      const db = await getSql();
      const [countsRow, bySourceRows, recentRows] = (await Promise.all([
        db`
          SELECT
            (SELECT count(*) FROM waitlist_signups)::text AS total,
            (SELECT count(*) FROM waitlist_signups WHERE converted_to_account_at IS NOT NULL)::text AS converted,
            (SELECT count(*) FROM waitlist_signups WHERE created_at > now() - interval '7 days')::text AS signups_7d,
            (SELECT count(*) FROM waitlist_signups WHERE created_at > now() - interval '30 days')::text AS signups_30d
        `,
        db`
          SELECT source, count(*)::text AS count
          FROM waitlist_signups
          GROUP BY source
          ORDER BY count(*) DESC
        `,
        db`
          SELECT id::text, email, source, referrer, created_at::text, converted_to_account_at::text
          FROM waitlist_signups
          ORDER BY created_at DESC
          LIMIT 25
        `,
      ])) as [CountsRow[], Array<{ source: string; count: string }>, RecentRow[]];

      const counts = countsRow[0];
      if (!counts) throw new Error('waitlist stats counts query returned empty');
      const total = Number.parseInt(counts.total, 10);
      const converted = Number.parseInt(counts.converted, 10);

      return {
        total,
        converted,
        conversionRate: total > 0 ? converted / total : 0,
        signups7d: Number.parseInt(counts.signups_7d, 10),
        signups30d: Number.parseInt(counts.signups_30d, 10),
        bySource: bySourceRows.map((r) => ({
          source: r.source ?? 'unknown',
          count: Number.parseInt(r.count, 10),
        })),
        recent: recentRows.map((r) => ({
          id: r.id,
          emailMasked: maskEmail(r.email),
          source: r.source ?? 'unknown',
          referrer: r.referrer,
          createdAt: new Date(r.created_at).toISOString(),
          convertedToAccountAt: r.converted_to_account_at
            ? new Date(r.converted_to_account_at).toISOString()
            : null,
        })),
      };
    })
  );
}
