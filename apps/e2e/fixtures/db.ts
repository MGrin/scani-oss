import { spawn } from 'node:child_process';

const DB_USER = 'scani';
const DB_NAME = 'scani';

function getContainerName(): string {
  // Override via env in CI (where the project name is derived from the
  // GH workspace). Locally, the docker-compose default is
  // <project>-<service>-<index> where <project> is the worktree dir
  // name.
  return process.env.POSTGRES_CONTAINER ?? 'mgrin-e2e-suite-postgres-1';
}

/**
 * Execute a SELECT against the dev Postgres via `docker exec psql -tAc`.
 * Returns the raw stdout split by newline (each line is a row;
 * multi-column rows are `|`-delimited; caller parses).
 *
 * Used only by the two specs that need a direct DB assertion the tRPC
 * surface doesn't expose (hashed-OTP storage check, cross-context state
 * verifications). Do NOT use this to seed test fixtures — tests should
 * drive everything through the real UI/API.
 */
export async function queryDb(sql: string): Promise<string[]> {
  const container = getContainerName();
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'docker',
      ['exec', container, 'psql', '-U', DB_USER, '-d', DB_NAME, '-tAc', sql],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`psql exited ${code}: ${stderr}`));
      resolve(stdout.split('\n').filter((line) => line.length > 0));
    });
  });
}
