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
 * What a `docker ps` attempt actually did, as opposed to whether it worked
 * (SC-591).
 *
 * The three failures used to collapse into one `null`, which made an ABSENT
 * daemon and a SLOW one the same fact. They are not the same fact and the
 * difference is used three times over — see `dockerPs` below for the retry,
 * and the callers for what they print.
 *
 * Measured on a 10-core Mac, 2026-08-23, unpiped:
 *
 *   outcome          ms    status   signal    error.code
 *   ok             1324         0     null    —
 *   absent          135         1     null    —          "failed to connect to the docker API…"
 *   sandbox denied  270         1     null    —          "permission denied while trying to connect…"
 *   timed out         9      null  SIGTERM    ETIMEDOUT  (measured with a 1ms cap)
 *
 * `absent` and `sandbox denied` share a signature and that is correct: both
 * are settled facts about the environment that a longer wait cannot change.
 * Only `timedOut` describes a question that was never asked.
 */
export type DockerProbe =
  | { kind: 'ok'; output: string }
  | { kind: 'timedOut' }
  | { kind: 'unavailable'; reason: string };

/**
 * Classify one attempt. Pure, so the tests drive every branch from a fixture
 * rather than from whatever the daemon is doing on the day — which is the
 * whole reason SC-591 took a second reporter to establish.
 */
export function classifyDockerProbe(probe: {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: { code?: string } | undefined;
}): DockerProbe {
  // The timeout is reported on `error`, never on `status` — a killed child has
  // a null status, so testing the status first would classify it as a plain
  // failure and lose the one case worth retrying.
  if (probe.error?.code === 'ETIMEDOUT') return { kind: 'timedOut' };
  if (probe.status !== 0 || typeof probe.stdout !== 'string') {
    const reason = (probe.stderr ?? '').trim().split('\n')[0] ?? '';
    return { kind: 'unavailable', reason: reason === '' ? 'docker exited non-zero' : reason };
  }
  return { kind: 'ok', output: probe.stdout };
}

/**
 * The first attempt's budget. Kept where it was, because it is what makes the
 * common case fast: an answering daemon returned in 1.3s and a denied socket
 * in 270ms, so nothing healthy is anywhere near it.
 */
export const FIRST_ATTEMPT_MS = 10_000;

/**
 * The retry's budget, paid ONLY on a timeout.
 *
 * WHY A RETRY AND NOT A HIGHER CAP, which is the fix this looks like it wants.
 * The defect is not that 10s is too small a number. It is that ONE SAMPLE IS
 * NOT A MEASUREMENT — the same shape as a spawn gate reading a single
 * 1-minute load average and firing on a dip. Raising the cap keeps one sample
 * and just moves the straddle point further out.
 *
 * The two halves are evidenced separately and are worth keeping apart:
 *
 *   RETRYING addresses the straddle, and that is a second reporter's
 *   measurement, not an inference. Their gate hit exit 8 on this call at load
 *   62; the same
 *   `docker ps` then succeeded BY HAND seconds later at the same load, and
 *   their re-run got past ownership at load 43. A call that fails and then
 *   succeeds under unchanged conditions was never describing the conditions.
 *
 *   THE LARGER BUDGET addresses a genuinely slow answer, and that is measured
 *   here: 12.6s at load 38 and 23.8s at load 36, against 5.7s at load 25. A
 *   second 10s attempt would straddle 23.8s exactly as the first one did.
 *
 * So: sample twice, and give the second sample room for the slowest answer
 * anyone has actually recorded. Neither half is sufficient alone.
 *
 * Bounded rather than unbounded because a hung daemon must not hang a gate:
 * worst case 40s, spent only when docker is genuinely slow, and never on the
 * absent or denied cases — those are classified out before the retry.
 */
export const RETRY_MS = 30_000;

/**
 * Sample twice, and ONLY when the first sample timed out.
 *
 * Injectable so the policy is provable from a fixture: a retry nobody has
 * watched fire is a retry that may not, and the test that matters most here is
 * the one asserting it does NOT fire — see `port-holder.test.ts`.
 *
 * THE RESTRAINT IS LOAD-BEARING, not tidiness. A denied socket is the ordinary
 * case for every agent on this machine and arrives in 270ms; retrying it would
 * put the whole 30s budget on every sandboxed run to re-learn a fact that
 * cannot change. An absent daemon is the same — the operator's next move is
 * `open -a OrbStack`, and no amount of waiting gets them there sooner. So the
 * cheap, common failures stay cheap and only the answerable one is paid for.
 *
 * Never throws and never blocks unboundedly: the callers are gates and
 * start-up paths whose job is to run.
 */
export function probeWithRetry(attempt: (timeoutMs: number) => DockerProbe): DockerProbe {
  const first = attempt(FIRST_ATTEMPT_MS);
  return first.kind === 'timedOut' ? attempt(RETRY_MS) : first;
}

function dockerPs(): DockerProbe {
  return probeWithRetry((timeout) =>
    classifyDockerProbe(
      spawnSync('docker', ['ps', '--no-trunc', '--format', DOCKER_PS_FORMAT], {
        encoding: 'utf8',
        timeout,
      })
    )
  );
}

export interface PortOwnership {
  /** `false` when docker could not be asked at all. */
  determined: boolean;
  holders: PortHolder[];
  foreign: PortHolder | null;
  /**
   * Why docker could not be asked, when `determined` is `false` (SC-591).
   *
   * `undetermined` is not one situation and a caller that prints it as one
   * gives half its readers a remedy for someone else's problem. A `timedOut`
   * reader is told to wait or re-run; an `unavailable` reader is told what
   * docker actually said, which is usually a socket path and a verb they can
   * act on. `null` when docker answered.
   */
  blind: DockerProbe | null;
}

/**
 * Who holds `port`, judged against `worktreePath`.
 *
 * A blind result is still a RESULT: `determined: false` with `blind` naming
 * which of the two blindnesses it was. Nothing here decides anything on the
 * strength of not knowing — that is each caller's call, and `gate-db` and
 * `db:dev` deliberately make it differently (SC-590).
 */
export function portOwnership(port: number, worktreePath: string): PortOwnership {
  const probe = dockerPs();
  if (probe.kind !== 'ok') {
    return { determined: false, holders: [], foreign: null, blind: probe };
  }
  const holders = parsePortHolders(probe.output, port);
  return {
    determined: true,
    holders,
    foreign: foreignHolder(holders, worktreePath),
    blind: null,
  };
}

/**
 * One sentence for a blind probe, matched to which blindness it was (SC-591).
 *
 * Deliberately says what the reader's NEXT ACTION differs on, because that is
 * the only reason this distinction is worth carrying: a timeout is a question
 * that can still be answered, and everything else is a settled fact about the
 * environment that no amount of waiting will change.
 */
export function describeBlindProbe(probe: DockerProbe): string {
  if (probe.kind === 'timedOut') {
    return (
      `docker ps did not answer within ${FIRST_ATTEMPT_MS / 1000}s, nor within ` +
      `${RETRY_MS / 1000}s on a retry — the box is loaded enough that the question ` +
      'could not be asked, not that it has no answer'
    );
  }
  if (probe.kind === 'unavailable') return `docker could not be asked: ${probe.reason}`;
  return 'docker answered';
}
