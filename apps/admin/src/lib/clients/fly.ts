import { cached } from '../cache';
import { getEnv } from '../env';
import { type Result, tryCatch } from '../result';

const GRAPHQL = 'https://api.fly.io/graphql';
const MACHINES = 'https://api.machines.dev/v1';

function auth(): { token: string; org: string } {
  const token = getEnv('FLY_API_TOKEN');
  if (!token) throw new Error('FLY_API_TOKEN missing');
  const org = getEnv('FLY_ORG') ?? 'personal';
  return { token, org };
}

async function gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const { token } = auth();
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Fly GraphQL ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length)
    throw new Error(`Fly GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
  if (!json.data) throw new Error('Fly GraphQL: empty response');
  return json.data;
}

export interface FlyApp {
  name: string;
  status: string;
  deployed: boolean;
  currentRelease: { version: number; createdAt: string } | null;
}

export interface FlyOrgOverview {
  slug: string;
  name: string;
  billingStatus: string | null;
  viewerRole: string | null;
  apps: FlyApp[];
}

export async function getFlyOverview(): Promise<Result<FlyOrgOverview>> {
  return tryCatch(() =>
    cached('fly:overview', 30, async () => {
      const { org } = auth();
      const data = await gql<{
        organization: {
          slug: string;
          name: string;
          billingStatus: string | null;
          viewerRole: string | null;
          apps: {
            nodes: Array<{
              name: string;
              status: string;
              deployed: boolean;
              currentRelease: { version: number; createdAt: string } | null;
            }>;
          };
        } | null;
      }>(
        `query($slug: String!) {
        organization(slug: $slug) {
          slug
          name
          billingStatus
          viewerRole
          apps(first: 50) {
            nodes {
              name
              status
              deployed
              currentRelease { version createdAt }
            }
          }
        }
      }`,
        { slug: org }
      );

      if (!data.organization) throw new Error(`Fly org '${org}' not found`);

      return {
        slug: data.organization.slug,
        name: data.organization.name,
        billingStatus: data.organization.billingStatus,
        viewerRole: data.organization.viewerRole,
        apps: data.organization.apps.nodes,
      };
    })
  );
}

export interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  image: string;
  createdAt: string;
}

export async function getFlyMachines(app: string): Promise<Result<FlyMachine[]>> {
  return tryCatch(() =>
    cached(`fly:machines:${app}`, 30, async () => {
      const { token } = auth();
      const res = await fetch(`${MACHINES}/apps/${app}/machines`, {
        headers: { authorization: `Bearer ${token}` },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`Fly machines ${res.status}: ${await res.text()}`);
      const raw = (await res.json()) as Array<{
        id: string;
        name: string;
        state: string;
        region: string;
        image_ref?: { repository?: string; tag?: string };
        created_at: string;
      }>;
      return raw.map((m) => ({
        id: m.id,
        name: m.name,
        state: m.state,
        region: m.region,
        image: m.image_ref?.repository
          ? `${m.image_ref.repository}:${m.image_ref.tag ?? 'latest'}`
          : 'unknown',
        createdAt: m.created_at,
      }));
    })
  );
}
