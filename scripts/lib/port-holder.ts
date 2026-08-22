/**
 * Who holds a host port, and whether they are this checkout (SC-500).
 *
 * WHY. `portOffset` gives a linked worktree one of 20 slots, so two worktrees
 * can draw the same one. The ticket calls that "loud", and it is loud only for
 * `docker compose up`, which meets it as a bind failure. Everything that
 * CONNECTS to a published port meets it silently. A test-suite runner opens
 * the OTHER checkout's Postgres, creates its scratch database in it, runs the
 * suite, drops it and prints a real count. Nothing in that output names the
 * server it used, and it leaves no artefact behind — so the victim can only
 * see it by counting databases during the window.
 *
 * The signal is the compose `working_dir` label, NOT the project name. The
 * primary checkout's stack is routinely started by a bare `docker compose up`,
 * which names the project after the directory leaf (`scani`) rather than the
 * derived `scani_mgrin_<digest>` — so comparing project names would refuse on
 * the one checkout that has never had this bug. `working_dir` is the directory
 * compose ran in, which is the question actually being asked.
 *
 * A container with no compose labels at all (a hand-rolled `docker run`, a
 * Postgres on the host) is UNKNOWN, not foreign. That is deliberate and it is
 * the conservative reading in the direction that matters here: an unknown
 * holder leaves the caller exactly as informed as it was before this file
 * existed, while a wrong "foreign" verdict would refuse a gate that had
 * nothing wrong with it, and a check that cries wolf is a check people delete.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface PortHolder {
  /** Container name, as `docker ps` prints it. */
  container: string;
  /** `com.docker.compose.project`, or `''` on a container compose did not create. */
  project: string;
  /** `com.docker.compose.project.working_dir`, or `''` when the label is absent. */
  workingDir: string;
}

/** The field order `dockerPs` asks for, and the order `parsePortHolders` reads. */
const DOCKER_PS_FORMAT =
  '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t' +
  '{{.Label "com.docker.compose.project.working_dir"}}\t{{.Ports}}';

/**
 * Every container publishing `port` on the host.
 *
 * The published port is the one BEFORE the arrow — `0.0.0.0:5933->5432/tcp`
 * publishes 5933 and exposes 5432. Matching anywhere in the string would make
 * a container whose *container* port is 5933 read as the holder of host 5933,
 * which is a different machine-wide fact and would produce a refusal nobody
 * could act on. Compared as numbers, so `:15933->` cannot match 5933 either.
 */
export function parsePortHolders(dockerPsOutput: string, port: number): PortHolder[] {
  const holders: PortHolder[] = [];

  for (const line of dockerPsOutput.split('\n')) {
    if (line.trim() === '') continue;
    const [container = '', project = '', workingDir = '', ports = ''] = line.split('\t');
    const published = [...ports.matchAll(/:(\d+)->/g)].map((m) => Number(m[1]));
    if (published.includes(port)) holders.push({ container, project, workingDir });
  }

  return holders;
}

/**
 * The first holder that is positively somebody else's checkout, or `null`.
 *
 * `null` covers three different situations on purpose — nothing holds the
 * port, the holder is this checkout, or the holder carries no compose labels
 * to judge by. The caller distinguishes them by whether it got any holders at
 * all; what it must never do is treat "cannot tell" as "foreign".
 */
export function foreignHolder(
  holders: readonly PortHolder[],
  worktreePath: string
): PortHolder | null {
  const mine = resolve(worktreePath);
  return holders.find((h) => h.workingDir !== '' && resolve(h.workingDir) !== mine) ?? null;
}

/**
 * One sentence a reader can act on, naming the container, the checkout the
 * label points at, and whether that directory still exists.
 *
 * The last clause is half of what SC-500 was filed for: compose projects were
 * running on this machine whose worktrees had been deleted, holding ports
 * nobody could attribute to anything.
 *
 * IT REPORTS A MISSING DIRECTORY AND NEVER CALLS A STACK ORPHANED, and the
 * difference is load-bearing. A deleted worktree that once ran a bare `docker
 * compose up` ADOPTED the default project — the directory leaf, `scani` in
 * every checkout — and stamped its own `working_dir` onto containers it did
 * not own. On this machine that is `scani-postgres` and `scani-redis` on 5433
 * and 6380: the ports CLAUDE.md and the test preload point at, serving the
 * PRIMARY checkout, under a label naming a directory that no longer exists.
 * A missing directory is NECESSARY and NOT SUFFICIENT for "nobody needs this";
 * the project name has to be one no live checkout produces as well.
 *
 * So this reports the evidence and never the conclusion. Nothing in this
 * repository removes a container on the strength of it.
 */
export function describeHolder(holder: PortHolder, port: number): string {
  const where =
    holder.workingDir === ''
      ? 'no compose working_dir label'
      : `${holder.workingDir}${existsSync(holder.workingDir) ? '' : ' — that directory no longer exists'}`;
  const project = holder.project === '' ? 'not a compose container' : holder.project;
  return `port ${port} is held by ${holder.container} (${project} · ${where})`;
}

/**
 * `docker ps` output, or `null` when docker could not answer.
 *
 * Never throws and never blocks for long: the callers are gates and start-up
 * paths, whose job is to run rather than to require a working docker CLI. A
 * sandbox that denies the docker socket makes `null` the ordinary reading, not
 * an exceptional one — which is exactly why the callers print what they could
 * not determine instead of pretending.
 */
function dockerPs(): string | null {
  const probe = spawnSync('docker', ['ps', '--no-trunc', '--format', DOCKER_PS_FORMAT], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return null;
  return probe.stdout;
}

export interface PortOwnership {
  /** `false` when docker could not be asked at all. */
  determined: boolean;
  holders: PortHolder[];
  foreign: PortHolder | null;
}

/** Who holds `port`, judged against `worktreePath`. */
export function portOwnership(port: number, worktreePath: string): PortOwnership {
  const output = dockerPs();
  if (output === null) return { determined: false, holders: [], foreign: null };
  const holders = parsePortHolders(output, port);
  return { determined: true, holders, foreign: foreignHolder(holders, worktreePath) };
}
