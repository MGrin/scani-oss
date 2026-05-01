import { cached } from '../cache';
import { getEnv } from '../env';
import { type Result, tryCatch } from '../result';

const BASE = 'https://api.cloudflare.com/client/v4';

function auth(): { token: string; accountId: string } {
  const token = getEnv('CLOUDFLARE_API_TOKEN');
  const accountId = getEnv('CLOUDFLARE_ACCOUNT_ID');
  if (!token || !accountId) throw new Error('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID missing');
  return { token, accountId };
}

async function req<T>(path: string): Promise<T> {
  const { token } = auth();
  const res = await fetch(`${BASE}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Cloudflare ${path} ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    success: boolean;
    errors?: Array<{ message: string }>;
    result: T;
  };
  if (!json.success)
    throw new Error(
      `Cloudflare: ${json.errors?.map((e) => e.message).join('; ') ?? 'unknown error'}`
    );
  return json.result;
}

export interface CfPagesProject {
  name: string;
  subdomain: string;
  productionBranch: string;
  createdAt: string;
  latestDeployment: {
    id: string;
    createdAt: string;
    environment: string;
    stage: string;
    url: string;
    source: string | null;
  } | null;
}

export async function getPagesProjects(): Promise<Result<CfPagesProject[]>> {
  return tryCatch(() =>
    cached('cloudflare:pages-projects', 120, async () => {
      const { accountId } = auth();
      const projects = await req<
        Array<{
          name: string;
          subdomain: string;
          production_branch: string;
          created_on: string;
          latest_deployment: {
            id: string;
            created_on: string;
            environment: string;
            latest_stage: { name: string; status: string } | null;
            url: string;
            deployment_trigger: { metadata?: { branch?: string; commit_message?: string } } | null;
          } | null;
        }>
      >(`/accounts/${accountId}/pages/projects`);

      return projects.map((p) => ({
        name: p.name,
        subdomain: p.subdomain,
        productionBranch: p.production_branch,
        createdAt: p.created_on,
        latestDeployment: p.latest_deployment
          ? {
              id: p.latest_deployment.id,
              createdAt: p.latest_deployment.created_on,
              environment: p.latest_deployment.environment,
              stage: p.latest_deployment.latest_stage?.status ?? 'unknown',
              url: p.latest_deployment.url,
              source: p.latest_deployment.deployment_trigger?.metadata?.commit_message ?? null,
            }
          : null,
      }));
    })
  );
}

export interface CfR2Bucket {
  name: string;
  createdAt: string;
  location: string | null;
}

export async function getR2Buckets(): Promise<Result<CfR2Bucket[]>> {
  return tryCatch(() =>
    cached('cloudflare:r2-buckets', 300, async () => {
      const { accountId } = auth();
      const res = await req<{
        buckets: Array<{ name: string; creation_date: string; location?: string }>;
      }>(`/accounts/${accountId}/r2/buckets`);
      return res.buckets.map((b) => ({
        name: b.name,
        createdAt: b.creation_date,
        location: b.location ?? null,
      }));
    })
  );
}

export interface CfZone {
  id: string;
  name: string;
  status: string;
  plan: string;
  developmentMode: number;
  nameServers: string[];
}

export async function getZones(): Promise<Result<CfZone[]>> {
  return tryCatch(() =>
    cached('cloudflare:zones', 300, async () => {
      const zones =
        await req<
          Array<{
            id: string;
            name: string;
            status: string;
            plan: { name: string } | null;
            development_mode: number;
            name_servers: string[];
          }>
        >('/zones');
      return zones.map((z) => ({
        id: z.id,
        name: z.name,
        status: z.status,
        plan: z.plan?.name ?? 'unknown',
        developmentMode: z.development_mode,
        nameServers: z.name_servers,
      }));
    })
  );
}

export interface CfDnsRecord {
  name: string;
  type: string;
  content: string;
  proxied: boolean;
}

export interface CfBillingProfile {
  id: string | null;
  firstName: string | null;
  lastName: string | null;
  country: string | null;
  paymentMethodType: string | null;
  lastFour: string | null;
  edited: string | null;
}

export async function getBillingProfile(): Promise<Result<CfBillingProfile>> {
  return tryCatch(() =>
    cached('cloudflare:billing-profile', 600, async () => {
      const p = await req<{
        id?: string;
        first_name?: string;
        last_name?: string;
        country?: string;
        edited_on?: string;
        card?: { last_four?: string; payment_method?: string };
        payment_method?: string;
      }>('/user/billing/profile');
      return {
        id: p.id ?? null,
        firstName: p.first_name ?? null,
        lastName: p.last_name ?? null,
        country: p.country ?? null,
        paymentMethodType: p.card?.payment_method ?? p.payment_method ?? null,
        lastFour: p.card?.last_four ?? null,
        edited: p.edited_on ?? null,
      };
    })
  );
}

export interface CfBillingHistoryItem {
  id: string;
  type: string;
  action: string;
  description: string;
  amount: number;
  currency: string;
  occurredAt: string;
  zone: { name: string } | null;
}

export async function getBillingHistory(): Promise<Result<CfBillingHistoryItem[]>> {
  return tryCatch(() =>
    cached('cloudflare:billing-history', 600, async () => {
      const raw = await req<
        Array<{
          id: string;
          type: string;
          action: string;
          description: string;
          amount: number;
          currency: string;
          occurred_at: string;
          zone?: { name?: string };
        }>
      >('/user/billing/history?per_page=10');
      return raw.map((h) => ({
        id: h.id,
        type: h.type,
        action: h.action,
        description: h.description,
        amount: h.amount,
        currency: h.currency,
        occurredAt: h.occurred_at,
        zone: h.zone?.name ? { name: h.zone.name } : null,
      }));
    })
  );
}

export async function getDnsRecords(zoneId: string): Promise<Result<CfDnsRecord[]>> {
  return tryCatch(() =>
    cached(`cloudflare:dns:${zoneId}`, 300, async () => {
      const records = await req<
        Array<{ name: string; type: string; content: string; proxied: boolean }>
      >(`/zones/${zoneId}/dns_records?per_page=100`);
      return records.map((r) => ({
        name: r.name,
        type: r.type,
        content: r.content,
        proxied: r.proxied,
      }));
    })
  );
}
