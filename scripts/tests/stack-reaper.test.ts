import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type CensusContainer,
  type CensusVolume,
  censusProjects,
  type MachineCensus,
} from '../lib/stack-census';
import {
  type ActionResult,
  describeReap,
  EXIT_CHECKOUTS_UNKNOWN,
  EXIT_DOCKER_BLIND,
  EXIT_INCOMPLETE,
  EXIT_NOT_REAPABLE,
  planReap,
  type ReapActions,
  reapExit,
  sweep,
} from '../lib/stack-reaper';
import { parseArgs } from '../reap-stacks';

/**
 * THE ARMS THAT MATTER HERE ARE THE ONES THAT MUST NOT FIRE.
 *
 * A run against a real daemon can demonstrate that a reap works. It cannot
 * demonstrate that a reap was correctly REFUSED without first arranging the
 * condition — a denied docker socket, a git that will not answer — and the
 * failure mode of getting one of those wrong is deleting somebody's database.
 * So every refusal is driven from a fixture, and the happy path is the small
 * half of this file.
 */

const OWN = 'scani_env_own00000_11111111';
const LIVE = 'scani_env_live0000_22222222';
const GONE = 'scani_env_gone0000_33333333';
const GONE_TWO = 'scani_env_gone0001_44444444';
/** Not a derivation at all — what a bare `docker compose up` produces. */
const BARE = 'scani';

function container(over: Partial<CensusContainer> = {}): CensusContainer {
  return { name: 'x-postgres-1', project: GONE, workingDir: '', running: false, ...over };
}

function volume(project: string, sizeBytes: number | null = 1_000_000): CensusVolume {
  return { name: `${project}_pgdata`, project, sizeBytes };
}

/** A census that answered, judged against `OWN` and `LIVE` as live checkouts. */
function census(over: Partial<MachineCensus> = {}): MachineCensus {
  const live = new Set([OWN, LIVE]);
  return {
    blind: null,
    checkouts: live.size,
    enumeration: { kind: 'enumerated', projects: live },
    projects: censusProjects({
      containers: [
        container({ project: OWN, workingDir: '/does/not/matter', running: true }),
        container({ project: LIVE, running: false }),
        container({ project: GONE, running: true }),
      ],
      volumes: [volume(OWN), volume(LIVE), volume(GONE), volume(GONE_TWO), volume(BARE)],
      liveProjects: live,
    }),
    ...over,
  };
}

function planned(over: Partial<MachineCensus> = {}, only: string | null = null) {
  const plan = planReap(census(over), OWN, only);
  if (plan.kind !== 'planned') throw new Error(`expected a plan, got: ${plan.reason}`);
  return plan;
}

describe('blindness never reads as death', () => {
  /**
   * The sandbox denies the docker socket and the denial arrives as an EMPTY
   * LIST, so `docker ps | wc -l` reads 0 on a box with running containers.
   * That is the ordinary case for every agent on this machine, not an exotic
   * one, and an empty project list is exactly what a genuinely clean machine
   * produces too.
   */
  test('a blind docker refuses instead of finding nothing to do', () => {
    const plan = planReap(
      {
        projects: [],
        blind: { kind: 'unavailable', reason: 'no socket' },
        checkouts: null,
        enumeration: null,
      },
      OWN
    );
    expect(plan.kind).toBe('refused');
    if (plan.kind !== 'refused') throw new Error('unreachable');
    expect(plan.exit).toBe(EXIT_DOCKER_BLIND);
    expect(plan.reason).toContain('docker could not be asked');
  });

  test('a timed-out docker refuses on the same arm — not a slower clean machine', () => {
    const plan = planReap(
      { projects: [], blind: { kind: 'timedOut' }, checkouts: null, enumeration: null },
      OWN
    );
    expect(plan.kind).toBe('refused');
  });

  /**
   * THE ARM THAT WOULD DO THE DAMAGE. `liveCheckoutProjects` falls back to
   * "this checkout is the only one" when git cannot be answered, so on a
   * machine with several worktrees an `assumed` enumeration puts every other
   * live stack — the primary checkout's included — outside the live set. The
   * census prints that under a heading telling the reader to check it. Acting
   * on it deletes a database.
   */
  test('an ASSUMED checkout set refuses, though it carries a plausible count', () => {
    const assumed = census({
      checkouts: 1,
      enumeration: { kind: 'assumed', projects: new Set([OWN]) },
    });
    const plan = planReap(assumed, OWN);
    expect(plan.kind).toBe('refused');
    if (plan.kind !== 'refused') throw new Error('unreachable');
    expect(plan.exit).toBe(EXIT_CHECKOUTS_UNKNOWN);
    expect(plan.reason).toContain('ASSUMED');
  });

  test('an unreadable checkout set refuses', () => {
    const plan = planReap(census({ enumeration: { kind: 'unreadable' }, checkouts: null }), OWN);
    expect(plan.kind).toBe('refused');
    if (plan.kind !== 'refused') throw new Error('unreachable');
    expect(plan.exit).toBe(EXIT_CHECKOUTS_UNKNOWN);
  });

  /**
   * The control for the three refusals above: the SAME machine, with the
   * enumeration answered, does find something. Without this a `planReap` that
   * refused unconditionally would pass every test in this describe block.
   */
  test('CONTROL — with docker and git both answered, the same machine yields a plan', () => {
    const plan = planned();
    expect(plan.reap.map((t) => t.project).sort()).toEqual([GONE, GONE_TWO]);
  });
});

describe('what a plan refuses to touch', () => {
  test("the caller's own project is never in the plan", () => {
    expect(planned().reap.some((t) => t.project === OWN)).toBe(false);
  });

  test('a live checkout whose stack is merely DOWN is never in the plan', () => {
    const plan = planned();
    expect(plan.reap.some((t) => t.project === LIVE)).toBe(false);
    expect(plan.keep.find((k) => k.project === LIVE)?.reason).toContain('may return to it');
  });

  /**
   * A bare `docker compose up` adopts the directory leaf as the project name,
   * so `scani` may be serving the primary checkout right now. It is not a
   * derivation any checkout produces, so it is `unattributed`, and
   * cannot-tell is never nobody-needs-it.
   */
  test('an unattributed project is never in the plan', () => {
    const plan = planned();
    expect(plan.reap.some((t) => t.project === BARE)).toBe(false);
    expect(plan.keep.find((k) => k.project === BARE)?.reason).toContain('never reclaimable');
  });

  test('every project on the machine is either reaped or accounted for', () => {
    const plan = planned();
    const seen = [...plan.reap.map((t) => t.project), ...plan.keep.map((k) => k.project)].sort();
    expect(seen).toEqual([BARE, GONE, GONE_TWO, LIVE, OWN].sort());
  });
});

describe('--project is a narrowing, never an override', () => {
  test('naming a reclaimable project plans only that one', () => {
    const plan = planned({}, GONE);
    expect(plan.reap.map((t) => t.project)).toEqual([GONE]);
    expect(plan.keep.find((k) => k.project === GONE_TWO)?.reason).toContain('named another');
  });

  test('naming a LIVE project is refused, and says which state it is in', () => {
    const plan = planReap(census(), OWN, LIVE);
    expect(plan.kind).toBe('refused');
    if (plan.kind !== 'refused') throw new Error('unreachable');
    expect(plan.exit).toBe(EXIT_NOT_REAPABLE);
    expect(plan.reason).toContain('may return to it');
  });

  test("naming the caller's own project is refused", () => {
    const plan = planReap(census(), OWN, OWN);
    expect(plan.kind).toBe('refused');
  });

  test('naming an unattributed project is refused', () => {
    const plan = planReap(census(), OWN, BARE);
    expect(plan.kind).toBe('refused');
  });

  test('naming a project that is not on this machine is refused, not a silent no-op', () => {
    const plan = planReap(census(), OWN, 'scani_env_absent00_99999999');
    expect(plan.kind).toBe('refused');
    if (plan.kind !== 'refused') throw new Error('unreachable');
    expect(plan.reason).toContain('holds nothing on this machine');
  });
});

/** A `ReapActions` that records what it was asked to do and never touches docker. */
function recorder(over: Partial<ReapActions> = {}): ReapActions & { calls: string[] } {
  const calls: string[] = [];
  const base: ReapActions = {
    composeDown(project) {
      calls.push(`down ${project}`);
      return { ok: true };
    },
    remaining(project) {
      calls.push(`remaining ${project}`);
      return { containers: 0, volumes: [] };
    },
    removeVolume(name) {
      calls.push(`rmvol ${name}`);
      return { ok: true };
    },
  };
  return { ...base, ...over, calls };
}

describe('the sweep proves it finished rather than trusting the teardown', () => {
  test('a clean teardown reports reaped', () => {
    const actions = recorder();
    const report = sweep(planned(), actions);
    expect(report.reaped.map((t) => t.project).sort()).toEqual([GONE, GONE_TWO]);
    expect(report.failed).toEqual([]);
    expect(reapExit(report)).toBe(0);
    expect(actions.calls).toContain(`down ${GONE}`);
  });

  /**
   * `docker compose -p` resolves the project from labels with no compose file
   * to read, so `--volumes` has no `volumes:` section to enumerate. The
   * label-driven removal is what makes "0 volumes remain" a measurement rather
   * than a hope.
   */
  test('a volume the down left behind is removed by name and then re-checked', () => {
    let asked = 0;
    const actions = recorder({
      remaining(project) {
        asked += 1;
        return asked === 1
          ? { containers: 0, volumes: [`${project}_pgdata`] }
          : { containers: 0, volumes: [] };
      },
    });
    const report = sweep(planned({}, GONE), actions);
    expect(actions.calls).toContain(`rmvol ${GONE}_pgdata`);
    expect(report.reaped.map((t) => t.project)).toEqual([GONE]);
  });

  test('a project whose volumes survive both attempts is FAILED, not reaped', () => {
    const actions = recorder({
      remaining: (project) => ({ containers: 0, volumes: [`${project}_pgdata`] }),
      removeVolume: (): ActionResult => ({ ok: false, why: 'volume is in use' }),
    });
    const report = sweep(planned({}, GONE), actions);
    expect(report.reaped).toEqual([]);
    expect(report.failed[0]?.why).toContain('volume is in use');
    expect(reapExit(report)).toBe(EXIT_INCOMPLETE);
  });

  test('a failed compose down is reported and the project is not reaped', () => {
    const actions = recorder({
      composeDown: (): ActionResult => ({ ok: false, why: 'permission denied' }),
    });
    const report = sweep(planned({}, GONE), actions);
    expect(report.reaped).toEqual([]);
    expect(report.failed).toEqual([{ project: GONE, why: 'permission denied' }]);
    expect(actions.calls).not.toContain(`remaining ${GONE}`);
  });

  /**
   * The teardown may well have worked. It is still not a clean teardown, for
   * the reason `downVerdict` refuses to print a bare success it cannot prove:
   * `null` is not zero and is never resolved toward it.
   */
  test('a blind re-probe is UNVERIFIED rather than reaped', () => {
    const actions = recorder({ remaining: () => null });
    const report = sweep(planned({}, GONE), actions);
    expect(report.reaped).toEqual([]);
    expect(report.unverified).toEqual([GONE]);
    expect(reapExit(report)).toBe(EXIT_INCOMPLETE);
    expect(describeReap(report, true)).toContain('UNVERIFIED');
  });
});

describe('the verdict is one line, including the quiet case', () => {
  test('nothing to reclaim still says so', () => {
    const text = describeReap({ reaped: [], failed: [], unverified: [], kept: [] }, false);
    expect(text).toContain('nothing to reclaim');
  });

  test('a dry run says WOULD and an applied run does not', () => {
    const report = sweep(planned(), recorder());
    expect(describeReap(report, false)).toContain('WOULD reclaim');
    expect(describeReap(report, true)).not.toContain('WOULD');
    expect(describeReap(report, true)).toContain('reclaimed 2 compose project(s)');
  });

  test('the verdict carries the volume count and the disk it frees', () => {
    const text = describeReap(sweep(planned(), recorder()), true);
    expect(text).toContain('2 volume(s)');
    expect(text).toContain('2.0MB');
  });
});

describe('argument parsing refuses what it does not understand', () => {
  test('the default is a dry run', () => {
    expect(parseArgs([])).toEqual({ apply: false, project: null });
  });

  test('--apply is the only way past the dry run', () => {
    expect(parseArgs(['--apply'])).toEqual({ apply: true, project: null });
  });

  /**
   * Symmetric on purpose. A dropped `--apply` is recoverable; a dropped
   * `--dry-run`-shaped negative that this tool does not have would silently
   * run the destructive path, so neither is ignored.
   */
  test('an unknown flag is a usage error, never ignored', () => {
    expect(parseArgs(['--dry-run'])).toHaveProperty('usage');
    expect(parseArgs(['--force'])).toHaveProperty('usage');
  });

  test('--project with no value is a usage error', () => {
    expect(parseArgs(['--project'])).toHaveProperty('usage');
    expect(parseArgs(['--project', '--apply'])).toHaveProperty('usage');
  });
});

describe('the reporter is still a reporter', () => {
  /**
   * SC-530's guard says turning the census into a reaper must be a deliberate
   * act that deletes a test. This ticket did the deliberate act in a SEPARATE
   * file, so that guard has to still be intact — a reaper landing beside a
   * census whose guard was quietly relaxed is exactly what it exists to catch.
   */
  test('stack-census.ts and stacks.ts still carry no removal verb', () => {
    for (const relative of ['../lib/stack-census.ts', '../stacks.ts']) {
      const source = readFileSync(path.join(import.meta.dir, relative), 'utf8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const verb of ['rm', 'prune', 'stop', 'kill', 'down']) {
        expect(code).not.toMatch(new RegExp(`['"\`]${verb}['"\`]`));
      }
    }
  });

  test('the reaper it points at exists and is a real command', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(import.meta.dir, '../../package.json'), 'utf8')
    ) as { scripts: Record<string, string> };
    // `orphanClause` names this on every `dev:stack:down`. A clause naming a
    // command that does not exist is worse than no clause: the reader spends
    // their one moment of attention on a typo.
    expect(pkg.scripts['dev:stacks:reap']).toBe('bun scripts/reap-stacks.ts');
    const census = readFileSync(path.join(import.meta.dir, '../lib/stack-census.ts'), 'utf8');
    expect(census).toContain('bun run dev:stacks:reap');
  });
});
