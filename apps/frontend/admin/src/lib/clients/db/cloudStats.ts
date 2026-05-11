import { cached } from '../../cache';
import { type Result, tryCatch } from '../../result';
import { getSql } from './sql';

export interface CloudStats {
  users: number;
  apiKeys: number;
  apiKeysActive: number;
  apiKeysRevoked: number;
  /** API keys grouped by their `tier` column. */
  byTier: Array<{ tier: string; count: number }>;
  /** API keys grouped by `billing_status`. */
  byBillingStatus: Array<{ status: string; count: number }>;
  /** Recently used API keys (last 14 days) with usage roll-ups. */
  recent: Array<{
    id: string;
    name: string;
    keyPrefix: string;
    ownerEmailMasked: string;
    tier: string;
    billingStatus: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }>;
  /** 24-hour usage event rollup. */
  events24h: {
    total: number;
    errors: number;
    /** Top routes by request count. */
    topRoutes: Array<{ route: string; count: number }>;
  };
}

interface CountsRow {
  users: string;
  api_keys: string;
  api_keys_active: string;
  api_keys_revoked: string;
  events_24h: string;
  events_errors_24h: string;
}

function maskEmail(email: string | null): string {
  if (!email) return '—';
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'•'.repeat(Math.max(1, local.length - visible.length))}${email.slice(at)}`;
}

export async function getCloudStats(): Promise<Result<CloudStats>> {
  return tryCatch(() =>
    cached('app-db:cloud-stats', 60, async () => {
      const db = await getSql();
      const [countsRow, byTierRows, byStatusRows, recentRows, topRoutesRows] = (await Promise.all([
        db`
          SELECT
            (SELECT count(*) FROM cloud_users)::text AS users,
            (SELECT count(*) FROM cloud_api_keys)::text AS api_keys,
            (SELECT count(*) FROM cloud_api_keys WHERE revoked_at IS NULL)::text AS api_keys_active,
            (SELECT count(*) FROM cloud_api_keys WHERE revoked_at IS NOT NULL)::text AS api_keys_revoked,
            (SELECT count(*) FROM cloud_usage_events
              WHERE occurred_at > now() - interval '24 hours'
            )::text AS events_24h,
            (SELECT count(*) FROM cloud_usage_events
              WHERE occurred_at > now() - interval '24 hours'
                AND outcome != 'success'
            )::text AS events_errors_24h
        `,
        db`
          SELECT tier, count(*)::text AS count
          FROM cloud_api_keys
          WHERE revoked_at IS NULL
          GROUP BY tier
          ORDER BY count(*) DESC
        `,
        db`
          SELECT billing_status AS status, count(*)::text AS count
          FROM cloud_api_keys
          GROUP BY billing_status
          ORDER BY count(*) DESC
        `,
        db`
          SELECT
            k.id::text,
            k.name,
            k.key_prefix,
            u.email AS owner_email,
            k.tier,
            k.billing_status,
            k.last_used_at::text,
            k.revoked_at::text
          FROM cloud_api_keys k
          LEFT JOIN cloud_users u ON u.id = k.owner_user_id
          ORDER BY COALESCE(k.last_used_at, k.created_at) DESC
          LIMIT 20
        `,
        db`
          SELECT route, count(*)::text AS count
          FROM cloud_usage_events
          WHERE occurred_at > now() - interval '24 hours'
          GROUP BY route
          ORDER BY count(*) DESC
          LIMIT 10
        `,
      ])) as [
        CountsRow[],
        Array<{ tier: string; count: string }>,
        Array<{ status: string; count: string }>,
        Array<{
          id: string;
          name: string;
          key_prefix: string;
          owner_email: string | null;
          tier: string;
          billing_status: string;
          last_used_at: string | null;
          revoked_at: string | null;
        }>,
        Array<{ route: string; count: string }>,
      ];

      const counts = countsRow[0];
      if (!counts) throw new Error('cloud stats counts query returned empty');

      return {
        users: Number.parseInt(counts.users, 10),
        apiKeys: Number.parseInt(counts.api_keys, 10),
        apiKeysActive: Number.parseInt(counts.api_keys_active, 10),
        apiKeysRevoked: Number.parseInt(counts.api_keys_revoked, 10),
        byTier: byTierRows.map((r) => ({
          tier: r.tier ?? 'unknown',
          count: Number.parseInt(r.count, 10),
        })),
        byBillingStatus: byStatusRows.map((r) => ({
          status: r.status ?? 'unknown',
          count: Number.parseInt(r.count, 10),
        })),
        recent: recentRows.map((r) => ({
          id: r.id,
          name: r.name,
          keyPrefix: r.key_prefix,
          ownerEmailMasked: maskEmail(r.owner_email),
          tier: r.tier ?? 'unknown',
          billingStatus: r.billing_status ?? 'unknown',
          lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
          revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
        })),
        events24h: {
          total: Number.parseInt(counts.events_24h, 10),
          errors: Number.parseInt(counts.events_errors_24h, 10),
          topRoutes: topRoutesRows.map((r) => ({
            route: r.route ?? 'unknown',
            count: Number.parseInt(r.count, 10),
          })),
        },
      };
    })
  );
}
