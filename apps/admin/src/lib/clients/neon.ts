import { cached } from '../cache';
import { getEnv } from '../env';
import { type Result, tryCatch } from '../result';

const BASE = 'https://console.neon.tech/api/v2';

// Matches the Terraform default in infra/terraform/variables.tf. Override
// by setting NEON_ORG_ID in ~/.secrets.
const DEFAULT_ORG_ID = 'org-autumn-dust-88271133';

function token(): string {
  const t = getEnv('NEON_API_KEY');
  if (!t) throw new Error('NEON_API_KEY missing');
  return t;
}

function orgId(): string {
  return getEnv('NEON_ORG_ID') ?? DEFAULT_ORG_ID;
}

async function req<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token()}`,
    },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Neon ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export interface NeonProject {
  id: string;
  name: string;
  platformId: string;
  regionId: string;
  pgVersion: number;
  storeBytes: number;
  syntheticStorageSize: number | null;
  cpuUsedSec: number;
  computeHours: number;
  dataTransferBytes: number;
  writtenDataBytes: number;
  branchCount: number;
  createdAt: string;
  plan: string;
}

export async function getNeonProjects(): Promise<Result<NeonProject[]>> {
  return tryCatch(() =>
    cached('neon:projects', 60, async () => {
      const list = await req<{ projects: Array<Record<string, unknown>> }>(
        `/projects?org_id=${encodeURIComponent(orgId())}`
      );

      return Promise.all(
        list.projects.map(async (p) => {
          const id = p.id as string;
          const branches = await req<{ branches: unknown[] }>(`/projects/${id}/branches`).catch(
            () => ({
              branches: [],
            })
          );

          return {
            id,
            name: (p.name as string) ?? id,
            platformId: (p.platform_id as string) ?? 'unknown',
            regionId: (p.region_id as string) ?? 'unknown',
            pgVersion: (p.pg_version as number) ?? 0,
            storeBytes: (p.store_bytes as number) ?? 0,
            syntheticStorageSize: (p.synthetic_storage_size as number | null) ?? null,
            cpuUsedSec: (p.cpu_used_sec as number) ?? 0,
            computeHours: Math.round((((p.cpu_used_sec as number) ?? 0) / 3600) * 100) / 100,
            dataTransferBytes: (p.data_transfer_bytes as number) ?? 0,
            writtenDataBytes: (p.written_data_bytes as number) ?? 0,
            branchCount: branches.branches.length,
            createdAt: (p.created_at as string) ?? '',
            plan:
              ((p.owner as Record<string, unknown> | undefined)?.plan as string | undefined) ??
              (p.plan as string | undefined) ??
              'unknown',
          };
        })
      );
    })
  );
}

export interface NeonConnectionUri {
  uri: string;
  pooled: boolean;
}

let cachedConnection: string | null = null;

export async function getDatabaseUrl(): Promise<string> {
  if (cachedConnection) return cachedConnection;
  const projects = await req<{ projects: Array<{ id: string }> }>(
    `/projects?org_id=${encodeURIComponent(orgId())}`
  );
  const project = projects.projects[0];
  if (!project) throw new Error('No Neon projects');

  const branches = await req<{ branches: Array<{ id: string; default: boolean }> }>(
    `/projects/${project.id}/branches`
  );
  const branch = branches.branches.find((b) => b.default) ?? branches.branches[0];
  if (!branch) throw new Error('No Neon branches');

  const databases = await req<{ databases: Array<{ name: string; owner_name: string }> }>(
    `/projects/${project.id}/branches/${branch.id}/databases`
  );
  const db = databases.databases[0];
  if (!db) throw new Error('No Neon databases');

  const endpoints = await req<{
    endpoints: Array<{ id: string; branch_id: string; host: string }>;
  }>(`/projects/${project.id}/endpoints`);
  const endpoint = endpoints.endpoints.find((e) => e.branch_id === branch.id);
  if (!endpoint) throw new Error('No Neon endpoint for branch');

  const pwRes = await req<{ password: string }>(
    `/projects/${project.id}/branches/${branch.id}/roles/${encodeURIComponent(
      db.owner_name
    )}/reveal_password`
  );

  const pooledHost = endpoint.host.replace(/^(ep-[^.]+)/, '$1-pooler');
  cachedConnection = `postgresql://${encodeURIComponent(db.owner_name)}:${encodeURIComponent(
    pwRes.password
  )}@${pooledHost}/${db.name}?sslmode=require`;
  return cachedConnection;
}
