/**
 * Reclaim the compose projects `stack-census.ts` reports as having no checkout
 * behind them (SC-803).
 *
 * ## Why this is a second file rather than a flag on the census
 *
 * `stack-census.ts` and `stacks.ts` are reporters and stay reporters:
 * `stack-census.test.ts` fails if a removal verb ever appears in either, so
 * that turning the census into a reaper has to be a deliberate act that deletes
 * a test rather than a patch somebody lands while adding a flag. That guard is
 * intact — this file is a CONSUMER of the census, and the separation is what
 * keeps `bun run dev:stacks` safe to run without reading its source first.
 *
 * ## What actually leaks, and why the obvious teardown does not fix it
 *
 * A worktree's stack is isolated by its compose PROJECT NAME, derived from the
 * worktree's absolute path (SC-491). Delete the worktree and the path is gone,
 * so the project can no longer be named by the tooling that created it:
 * `bun run dev:stack:down` needs the directory it is being run from. The
 * teardown is unavailable exactly when it is needed.
 *
 * The by-hand attempt is worse than unavailable, because it SUCCEEDS. Measured
 * 2026-09-02 on two stacks:
 *
 *     cd <worktree> && docker compose down --volumes --remove-orphans
 *       -> rc=0, EMPTY output, and both stacks were still running(4) after
 *
 * `docker-compose.yml` names no containers, so a bare `down` takes the project
 * from the DIRECTORY LEAF — `scani` in every worktree of this repository, a
 * project holding nothing. It is a well-formed no-op that reports success. This
 * is the removal-side twin of the `up` adoption hazard SC-491 closed.
 *
 * So the order matters and is the reverse of the natural one: tear down with
 * the derived project name, THEN remove the worktree. Reversed, the stack is
 * stranded and nothing says so — which is the rate this file exists to change,
 * because the number is not the finding. Six orphaned projects were counted on
 * 2026-08-22 and twenty-one a week later. A one-off sweep leaves the rate
 * exactly where it was.
 *
 * ## Why `-p` is the whole remedy
 *
 * `docker compose -p <project> down --volumes --remove-orphans` needs no
 * compose file: compose finds the containers, networks and volumes by their
 * `com.docker.compose.project` label. It therefore still works after the
 * directory is gone, which is the one property the supported path lacks.
 *
 * ## Blindness never reads as death
 *
 * Every way of not knowing refuses, and none of them resolves toward the
 * destructive answer. That is `gate-orphans.ts`'s rule, applied to a second
 * resource: there, `lsof` being denied classifies every marker `unreadable`, so
 * NO marker is `abandoned` and nothing is reaped. Here there are two
 * instruments and both must answer:
 *
 *   docker blind      -> REFUSED. The census returns no projects when it cannot
 *                        ask, and an empty project list is indistinguishable
 *                        from a clean machine. In the agent sandbox the docker
 *                        socket is denied and the denial arrives as an EMPTY
 *                        LIST, so this is the ordinary case, not an exotic one.
 *   git not enumerated -> REFUSED, and this is the one that would do the
 *                        damage. `liveCheckoutProjects` falls back to "this
 *                        checkout is the only one" when git cannot be asked, so
 *                        on a machine with seven worktrees a failed `git` call
 *                        makes six live stacks — the primary checkout's among
 *                        them — fall outside the live set and read as
 *                        reclaimable. The census prints that under a heading
 *                        telling the reader to check it; a reaper cannot.
 *
 * `unattributed` is never reaped either, for the reason `isReclaimable` already
 * encodes: a project whose name is not a derivation at all (the bare `scani` a
 * hand-rolled `docker compose up` produces) may be serving the primary
 * checkout, and cannot-tell is not nobody-needs-it.
 */

import {
  type CheckoutEnumeration,
  formatBytes,
  isReclaimable,
  type MachineCensus,
  type StackProject,
} from './stack-census';

/** What one project's teardown attempt did. `why` is the first line only. */
export type ActionResult = { readonly ok: true } | { readonly ok: false; readonly why: string };

/**
 * The docker calls a sweep makes, injected so the whole policy is provable from
 * a fixture — including the arms that must NOT fire, which are the ones a run
 * against a real daemon cannot demonstrate without leaving damage behind.
 */
export interface ReapActions {
  /** `docker compose -p <project> down --volumes --remove-orphans`. */
  composeDown(project: string): ActionResult;
  /**
   * What still carries this project's label after the `down`, or `null` when
   * docker could not be asked.
   *
   * `null` is NOT an empty result and is never read as one — the same rule
   * `downVerdict` follows in `dev-stack.ts`. A teardown that cannot prove it
   * finished reports as unverified rather than as clean.
   */
  remaining(project: string): { readonly containers: number; readonly volumes: string[] } | null;
  /** `docker volume rm <name>`, for a volume `down --volumes` did not take. */
  removeVolume(name: string): ActionResult;
}

/** One project the plan will act on, with what it is expected to reclaim. */
export interface ReapTarget {
  readonly project: string;
  readonly containers: number;
  readonly volumes: number;
  /** `null` when any volume's size was unreadable — never 0. */
  readonly bytes: number | null;
}

/** One project the plan deliberately leaves alone, and why. */
export interface KeptProject {
  readonly project: string;
  readonly reason: string;
}

export type ReapPlan =
  /** Nothing was decided, because a question this depends on was not answered. */
  | { readonly kind: 'refused'; readonly reason: string; readonly exit: number }
  | {
      readonly kind: 'planned';
      readonly reap: readonly ReapTarget[];
      readonly keep: readonly KeptProject[];
      /** How many checkouts the attribution was judged against. */
      readonly checkouts: number;
    };

/** Docker could not be asked, so nothing on this machine was enumerated. */
export const EXIT_DOCKER_BLIND = 3;
/** The live checkouts could not be enumerated, so nothing can be attributed. */
export const EXIT_CHECKOUTS_UNKNOWN = 4;
/** `--project` named something this may not reclaim. */
export const EXIT_NOT_REAPABLE = 5;
/** A teardown was attempted and did not finish. */
export const EXIT_INCOMPLETE = 1;

function refuseEnumeration(e: CheckoutEnumeration | null): string | null {
  if (e === null || e.kind === 'unreadable') {
    return (
      'the checkouts of this repository could not be enumerated — `git worktree list` ' +
      'did not answer usably, so no project can be attributed to a checkout and none ' +
      'may be reclaimed'
    );
  }
  if (e.kind === 'assumed') {
    return (
      'git could not be asked which checkouts exist, so this one was ASSUMED to be the ' +
      'only one. Every other stack on this machine would fall outside the live set and ' +
      "read as reclaimable, including the primary checkout's. Nothing may be reclaimed " +
      'on an assumption — run `bun run dev:stacks` to see the report, which says what it ' +
      'judged against'
    );
  }
  return null;
}

function describeKept(p: StackProject): string {
  if (p.state === 'unattributed') {
    return `${p.project} is not a name any checkout derives — it may be serving one anyway (a bare \`docker compose up\` adopts the directory leaf), so it is never reclaimable`;
  }
  const where = p.workingDir === null ? 'a live checkout' : p.workingDir;
  return p.state === 'live-running'
    ? `${p.project} belongs to ${where} and is running`
    : `${p.project} belongs to ${where}, stack down — someone may return to it`;
}

/**
 * What a sweep would do, or why it will not do anything.
 *
 * `ownProject` is the caller's own project, excluded from the plan even though
 * a live checkout can never be `gone-*`: this is the one project whose state
 * the caller can verify from where it is standing, and leaving the exclusion to
 * the census alone would put the caller's own stack behind a rule about
 * somebody else's.
 *
 * `only` narrows to one project by name, for the case this exists for — the
 * worktree is already gone and its project is the one thing the operator still
 * knows. It is subject to the identical guard, so naming a live project is a
 * refusal that says which state it is in rather than an override.
 */
export function planReap(
  census: MachineCensus,
  ownProject: string,
  only: string | null = null
): ReapPlan {
  if (census.blind !== null) {
    return {
      kind: 'refused',
      exit: EXIT_DOCKER_BLIND,
      reason:
        'docker could not be asked what is on this machine, so nothing was enumerated. ' +
        'An empty list is what a denied socket returns and what a clean machine returns, ' +
        'and this refuses rather than picking one',
    };
  }

  const enumerationRefusal = refuseEnumeration(census.enumeration);
  if (enumerationRefusal !== null) {
    return { kind: 'refused', exit: EXIT_CHECKOUTS_UNKNOWN, reason: enumerationRefusal };
  }

  const reap: ReapTarget[] = [];
  const keep: KeptProject[] = [];
  for (const p of census.projects) {
    if (p.project === ownProject) {
      keep.push({ project: p.project, reason: `${p.project} is this checkout's own stack` });
      continue;
    }
    if (!isReclaimable(p.state)) {
      keep.push({ project: p.project, reason: describeKept(p) });
      continue;
    }
    reap.push({
      project: p.project,
      containers: p.containers.length,
      volumes: p.volumes.length,
      bytes: p.bytes,
    });
  }

  if (only !== null) {
    const target = reap.find((t) => t.project === only);
    if (target === undefined) {
      const known = keep.find((k) => k.project === only);
      return {
        kind: 'refused',
        exit: EXIT_NOT_REAPABLE,
        reason:
          known === undefined
            ? `${only} holds nothing on this machine that this repository would recognise — check the name against \`bun run dev:stacks\``
            : `refusing ${only}: ${known.reason}`,
      };
    }
    return {
      kind: 'planned',
      reap: [target],
      keep: [...keep, ...reap.filter((t) => t !== target).map(asDeferred)],
      checkouts: census.checkouts ?? 0,
    };
  }

  return { kind: 'planned', reap, keep, checkouts: census.checkouts ?? 0 };
}

function asDeferred(t: ReapTarget): KeptProject {
  return { project: t.project, reason: `${t.project} is reclaimable, but --project named another` };
}

/** What a sweep actually did. */
export interface ReapReport {
  readonly reaped: readonly ReapTarget[];
  /** Attempted and did not finish, with the first line of why. */
  readonly failed: readonly { readonly project: string; readonly why: string }[];
  /**
   * Torn down, and docker could not confirm what remains. Not counted as
   * reaped: a teardown that cannot prove it finished is not a clean one.
   */
  readonly unverified: readonly string[];
  readonly kept: readonly KeptProject[];
}

/**
 * Run the plan.
 *
 * The `down` is followed by a re-probe rather than trusted, and any volume it
 * left behind is removed by NAME. `docker compose -p` resolves the project from
 * labels with no compose file to read, so `--volumes` has no `volumes:` section
 * to enumerate — the label-driven removal is what makes "0 volumes remain" a
 * measurement instead of a hope. A project whose volumes survive both is
 * reported failed rather than reaped.
 *
 * Never throws. A sweep that aborted halfway through would leave the operator
 * with a partial result and no account of it.
 */
export function sweep(
  plan: Extract<ReapPlan, { kind: 'planned' }>,
  actions: ReapActions
): ReapReport {
  const reaped: ReapTarget[] = [];
  const failed: { project: string; why: string }[] = [];
  const unverified: string[] = [];

  for (const target of plan.reap) {
    const down = actions.composeDown(target.project);
    if (!down.ok) {
      failed.push({ project: target.project, why: down.why });
      continue;
    }

    let left = actions.remaining(target.project);
    if (left === null) {
      unverified.push(target.project);
      continue;
    }

    for (const name of left.volumes) {
      const removed = actions.removeVolume(name);
      if (!removed.ok) failed.push({ project: target.project, why: `${name}: ${removed.why}` });
    }

    left = actions.remaining(target.project);
    if (left === null) {
      unverified.push(target.project);
    } else if (left.containers > 0 || left.volumes.length > 0) {
      if (!failed.some((f) => f.project === target.project)) {
        failed.push({
          project: target.project,
          why: `${left.containers} container(s) and ${left.volumes.length} volume(s) still carry this project's label`,
        });
      }
    } else {
      reaped.push(target);
    }
  }

  return { reaped, failed, unverified, kept: plan.keep };
}

function totalBytes(targets: readonly ReapTarget[]): number | null {
  return targets.some((t) => t.bytes === null)
    ? null
    : targets.reduce<number>((sum, t) => sum + (t.bytes ?? 0), 0);
}

/**
 * The verdict, ALWAYS one line, including the quiet case.
 *
 * Silence on a clean sweep would make "swept, found nothing" and "the sweep
 * never ran" the same reading — the failure this repository keeps meeting from
 * every side (SC-190's exit code that cannot tell "everything passed" from
 * "nothing ran"; `gate-db`'s `no orphaned gate database to reap`).
 *
 * The dry run says WOULD, and says how to apply it. A tool whose default is
 * safe and whose safe output looks like its acting output is a tool people
 * mis-read in the direction that costs something.
 */
export function describeReap(report: ReapReport, applied: boolean): string {
  const verb = applied ? 'reclaimed' : 'WOULD reclaim';
  const parts: string[] = [];

  if (report.reaped.length === 0) {
    parts.push(
      applied
        ? 'no compose project on this machine was reclaimable'
        : 'nothing to reclaim — no compose project on this machine is behind a deleted checkout'
    );
  } else {
    parts.push(
      `${verb} ${report.reaped.length} compose project(s) · ` +
        `${report.reaped.reduce((n, t) => n + t.volumes, 0)} volume(s) · ` +
        `${formatBytes(totalBytes(report.reaped))} · ` +
        report.reaped.map((t) => t.project).join(', ')
    );
  }

  if (report.unverified.length > 0) {
    parts.push(
      `${report.unverified.length} torn down but UNVERIFIED — docker could not be asked what ` +
        `remains, so this is not a clean teardown · ${report.unverified.join(', ')}`
    );
  }
  if (report.failed.length > 0) {
    parts.push(
      `${report.failed.length} could not be reclaimed · ` +
        report.failed.map((f) => `${f.project} (${f.why})`).join(', ')
    );
  }
  parts.push(
    report.kept.length === 0
      ? 'nothing else on this machine to leave alone'
      : `${report.kept.length} left alone`
  );

  return `reap-stacks: ${parts.join(' · ')}`;
}

/** The kept list, one per line, so a reader can check the judgement. */
export function describeKeptProjects(report: ReapReport): string {
  return report.kept.map((k) => `  keeping  ${k.reason}`).join('\n');
}

/** What a plan proposes, one per line, before anything is touched. */
export function describePlan(plan: Extract<ReapPlan, { kind: 'planned' }>): string {
  return plan.reap
    .map(
      (t) =>
        `  ${t.project}\n    ${t.containers} container(s) · ${t.volumes} volume(s) ${formatBytes(t.bytes)}`
    )
    .join('\n');
}

/**
 * The exit status a completed sweep deserves.
 *
 * A dry run that FOUND something is still exit 0: it did exactly what it was
 * asked to. Only an attempted teardown that did not finish, or one that could
 * not be verified, is a failure — for the same reason `dev-stack.ts` refuses to
 * print a bare success over a teardown it cannot prove.
 */
export function reapExit(report: ReapReport): number {
  return report.failed.length > 0 || report.unverified.length > 0 ? EXIT_INCOMPLETE : 0;
}
