/**
 * Which database does the stack under test actually use? (SC-494)
 *
 * `fixtures/db.ts` used to answer this with two constants — container
 * `mgrin-e2e-suite-postgres-1`, database `scani`. Both are wrong for any stack
 * the runner did not itself create, and wrong in the worst available way: a
 * constant produces a CONFIDENT WRONG TARGET rather than a refusal. A fallback
 * that is correct on one person's machine is silently wrong on everyone
 * else's.
 *
 * ## Why the API port is the right question to ask
 *
 * The runner decides Mode A by probing `${API_BASE_URL}/health`. So the one
 * thing it knows for certain is which api ANSWERED. Asking docker who
 * publishes that port ties the database to the process under test, and it
 * therefore cannot disagree with it. Every other route — deriving the compose
 * project from the worktree path, reading `SCANI_DEV_DB` out of the
 * environment — reconstructs the answer from a second source and can drift
 * from the thing being tested.
 *
 * ## Two lookups, and neither is optional
 *
 *   1. `docker ps --filter publish=<api port>` -> the api container, and the
 *      `com.docker.compose.project` label on it.
 *   2. `docker inspect <that container>` -> its `DATABASE_URL`, whose path
 *      component is the database name.
 *
 * The postgres container is then `<project>-postgres-1`, compose's own naming.
 *
 * ## No fallback, on purpose
 *
 * Every failure returns an `error` naming WHICH step failed. The caller must
 * carry that text to the point of use and refuse there — see
 * `fixtures/db.ts`, which throws it and says NO QUERY WAS MADE. A refusal
 * without that sentence reads as "the query ran and found nothing", which is
 * the same wrong conclusion by a shorter route.
 *
 * A host-side `bun dev` serving the api has no container at all. Refusing
 * there is not a gap: it is the honest answer to "which container serves
 * this" when there is none.
 */

interface StackDb {
  /** The postgres container to `docker exec` into. */
  readonly container: string;
  /** The database the api under test is actually connected to. */
  readonly database: string;
  /** The compose project both belong to, for the message when something is off. */
  readonly project: string;
}

export type StackDbResolution = StackDb | { readonly error: string };

/** Injected so the parsing above can be tested without a live docker. */
export interface DockerProbe {
  /** `docker ps --filter publish=<port> --format '{{.Names}}\t{{.Label "com.docker.compose.project"}}'` */
  containersPublishing(port: number): { readonly status: number; readonly stdout: string };
  /** `docker inspect <name> --format '{{range .Config.Env}}{{println .}}{{end}}'` */
  environmentOf(container: string): { readonly status: number; readonly stdout: string };
}

/**
 * The database name is the URL's path, minus the leading slash. Parsed rather
 * than regexed off the end because a `?sslmode=disable` query string is
 * present in every compose `DATABASE_URL` in this repo and would otherwise be
 * read as part of the name.
 */
export function databaseFromUrl(url: string): string | { readonly error: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `DATABASE_URL is not a URL: ${url}` };
  }
  const name = parsed.pathname.replace(/^\//, '');
  if (name.length === 0) return { error: `DATABASE_URL names no database: ${url}` };
  if (name.includes('/')) return { error: `DATABASE_URL path is not a single name: ${url}` };
  return name;
}

/** First non-empty line of `docker ps`, split on the tab the format string asks for. */
export function parsePublishingContainer(
  stdout: string
): { readonly name: string; readonly project: string } | { readonly error: string } {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { error: 'no container publishes that port' };
  const [name, project] = (lines[0] as string).split('\t');
  if (!name) return { error: 'docker named no container' };
  if (!project) return { error: `container ${name} carries no compose project label` };
  return { name, project };
}

/** `DATABASE_URL=` out of `docker inspect`'s env dump. */
export function databaseUrlFromEnv(stdout: string): string | { readonly error: string } {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('DATABASE_URL=')) return line.slice('DATABASE_URL='.length).trim();
  }
  return { error: 'the container declares no DATABASE_URL' };
}

export function resolveStackDb(apiPort: number, docker: DockerProbe): StackDbResolution {
  const ps = docker.containersPublishing(apiPort);
  if (ps.status !== 0) {
    return { error: `could not ask docker which container publishes :${apiPort}` };
  }
  const found = parsePublishingContainer(ps.stdout);
  if ('error' in found) {
    return {
      error: `${found.error} (:${apiPort}) — an api answered there, so it is served by something docker cannot see, such as a host-side \`bun dev\``,
    };
  }
  const env = docker.environmentOf(found.name);
  if (env.status !== 0) return { error: `could not inspect container ${found.name}` };
  const url = databaseUrlFromEnv(env.stdout);
  if (typeof url !== 'string') return { error: `${found.name}: ${url.error}` };
  const database = databaseFromUrl(url);
  if (typeof database !== 'string') return { error: `${found.name}: ${database.error}` };
  return { container: `${found.project}-postgres-1`, database, project: found.project };
}
