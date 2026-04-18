import { getEnv } from '../env';
import { type Result, tryCatch } from '../result';

const BASE = 'https://api.github.com';
const OWNER = 'MGrin';
const REPO = 'scani';

function token(): string {
  const t = getEnv('TF_GITHUB_TOKEN') ?? getEnv('GITHUB_TOKEN');
  if (!t) throw new Error('TF_GITHUB_TOKEN missing');
  return t;
}

async function req<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token()}`,
      'x-github-api-version': '2022-11-28',
    },
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`GitHub ${path} ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

export interface GhWorkflowRun {
  id: number;
  name: string;
  headBranch: string;
  event: string;
  status: string;
  conclusion: string | null;
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  runNumber: number;
}

export async function getRecentRuns(limit = 10): Promise<Result<GhWorkflowRun[]>> {
  return tryCatch(async () => {
    const data = await req<{
      workflow_runs: Array<{
        id: number;
        name: string;
        head_branch: string;
        event: string;
        status: string;
        conclusion: string | null;
        created_at: string;
        updated_at: string;
        html_url: string;
        run_number: number;
      }>;
    }>(`/repos/${OWNER}/${REPO}/actions/runs?per_page=${limit}`);
    return data.workflow_runs.map((r) => ({
      id: r.id,
      name: r.name,
      headBranch: r.head_branch,
      event: r.event,
      status: r.status,
      conclusion: r.conclusion,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      htmlUrl: r.html_url,
      runNumber: r.run_number,
    }));
  });
}

export interface GhRepoInfo {
  fullName: string;
  defaultBranch: string;
  stargazers: number;
  pushedAt: string;
  diskKb: number;
  visibility: string;
  openIssues: number;
}

export async function getRepoInfo(): Promise<Result<GhRepoInfo>> {
  return tryCatch(async () => {
    const data = await req<{
      full_name: string;
      default_branch: string;
      stargazers_count: number;
      pushed_at: string;
      size: number;
      visibility: string;
      open_issues_count: number;
    }>(`/repos/${OWNER}/${REPO}`);
    return {
      fullName: data.full_name,
      defaultBranch: data.default_branch,
      stargazers: data.stargazers_count,
      pushedAt: data.pushed_at,
      diskKb: data.size,
      visibility: data.visibility,
      openIssues: data.open_issues_count,
    };
  });
}
