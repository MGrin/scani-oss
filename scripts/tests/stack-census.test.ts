import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  type CensusContainer,
  type CensusVolume,
  censusProjects,
  formatBytes,
  formatCensus,
  inScope,
  isReclaimable,
  type MachineCensus,
  orphanClause,
  PROJECT_PREFIX,
  parseComposeContainers,
  parseHumanSize,
  parseVolumeList,
  parseVolumeSizes,
  type StackState,
} from '../lib/stack-census';
import { composeProjectName } from '../lib/worktree';

/**
 * SC-530. Compose stacks outlive the worktrees that made them: deleting a bb
 * worktree removes the directory and leaves the stack running, and nothing
 * reported it.
 *
 * The fixtures below have the shape of real output captured on 2026-08-26/27,
 * with synthetic paths and names (SC-566) — nothing here stats a real
 * directory except through `LIVE_DIR`, which is this file itself's directory
 * and therefore exists on any machine that can run the test.
 */

const LIVE_DIR = path.resolve(import.meta.dir);
const GONE_DIR = path.join(LIVE_DIR, 'definitely-absent-sc530');

const LIVE_PROJECT = composeProjectName(LIVE_DIR);
const GONE_PROJECT = composeProjectName(GONE_DIR);

function container(over: Partial<CensusContainer> & { project: string }): CensusContainer {
  return { name: `${over.project}-postgres-1`, workingDir: '', running: true, ...over };
}

function volume(project: string, sizeBytes: number | null = null): CensusVolume {
  return { name: `${project}_postgres-data`, project, sizeBytes };
}

describe('the census scope is pinned to the derivation, not to a spelling', () => {
  test('every derived project name is in scope', () => {
    // Without this, renaming `composeProjectName`'s prefix would empty the
    // census silently — a reporter that finds nothing reads exactly like one
    // that works and finds nothing.
    expect(composeProjectName('/anywhere/env_x/scani').startsWith(`${PROJECT_PREFIX}_`)).toBe(true);
    expect(inScope(composeProjectName('/anywhere/env_x/scani'))).toBe(true);
  });

  test('another product on the same machine is out of scope', () => {
    expect(inScope('ab-testpg')).toBe(false);
    expect(inScope('buildx_buildkit_scani-publish0')).toBe(false);
  });

  test('compose default project name is in scope, so it can be judged', () => {
    expect(inScope(PROJECT_PREFIX)).toBe(true);
  });
});

describe('a worktree that is gone is reclaimable; one that is merely idle is not', () => {
  const liveProjects = new Set([LIVE_PROJECT]);

  test('gone + containers running', () => {
    const [p] = censusProjects({
      containers: [container({ project: GONE_PROJECT, workingDir: GONE_DIR })],
      volumes: [volume(GONE_PROJECT)],
      liveProjects,
    });
    expect(p?.state).toBe('gone-running');
    expect(isReclaimable(p?.state as StackState)).toBe(true);
  });

  test('gone + volumes only — the state the ticket is actually about now', () => {
    // The real remnant on 2026-08-27: containers already died, storage did
    // not. A running-containers-only reporter reads CLEAN over this.
    const [p] = censusProjects({
      containers: [],
      volumes: [volume(GONE_PROJECT, 65_200_000)],
      liveProjects,
    });
    expect(p?.state).toBe('gone-idle');
    expect(isReclaimable(p?.state as StackState)).toBe(true);
    expect(p?.bytes).toBe(65_200_000);
  });

  test('LIVE worktree with its stack down is NOT reclaimable', () => {
    // The rule that must never bend: someone may return to this tomorrow.
    const [p] = censusProjects({
      containers: [],
      volumes: [volume(LIVE_PROJECT, 1_730_000_000)],
      liveProjects,
    });
    expect(p?.state).toBe('live-idle');
    expect(isReclaimable(p?.state as StackState)).toBe(false);
  });

  test('live-idle and gone-idle are never the same state', () => {
    const projects = censusProjects({
      containers: [],
      volumes: [volume(LIVE_PROJECT), volume(GONE_PROJECT)],
      liveProjects,
    });
    const states = projects.map((p) => p.state);
    expect(new Set(states).size).toBe(2);
    expect(projects.filter((p) => isReclaimable(p.state))).toHaveLength(1);
  });
});

describe('a missing working_dir is necessary and NOT sufficient', () => {
  test('the adopted default project is unattributed, never gone', () => {
    // SC-530's own correction. A checkout that ran a bare `docker compose up`
    // took compose's default project name and stamped its deleted path onto
    // containers serving the PRIMARY checkout on the documented ports. A
    // working_dir test calls that an orphan and is wrong.
    const [p] = censusProjects({
      containers: [container({ project: PROJECT_PREFIX, workingDir: GONE_DIR })],
      volumes: [],
      liveProjects: new Set([LIVE_PROJECT]),
    });
    expect(p?.state).toBe('unattributed');
    expect(isReclaimable(p?.state as StackState)).toBe(false);
  });

  test('a container whose working_dir EXISTS is live even if the derivation misses it', () => {
    // A second clone elsewhere on the disk: this repo's `git worktree list`
    // cannot see it, so only the label can save it from reading as gone.
    const [p] = censusProjects({
      containers: [
        container({ project: `${PROJECT_PREFIX}_other_deadbeef`, workingDir: LIVE_DIR }),
      ],
      volumes: [],
      liveProjects: new Set([LIVE_PROJECT]),
    });
    expect(p?.state).toBe('live-running');
  });
});

describe('a question that was never answered is not an answer', () => {
  test('a null live set makes everything unattributed, never gone', () => {
    // Resolving `null` to an empty set would call every project on the machine
    // reclaimable — the maximally destructive reading of an unasked question.
    const projects = censusProjects({
      containers: [container({ project: GONE_PROJECT, workingDir: GONE_DIR })],
      volumes: [volume(GONE_PROJECT)],
      liveProjects: null,
    });
    expect(projects.map((p) => p.state)).toEqual(['unattributed']);
    expect(projects.filter((p) => isReclaimable(p.state))).toHaveLength(0);
  });

  test('an unreadable size is unknown, not zero', () => {
    expect(parseHumanSize('what')).toBeNull();
    const [p] = censusProjects({
      containers: [],
      volumes: [volume(GONE_PROJECT, null), volume(GONE_PROJECT, 5)],
      liveProjects: new Set([LIVE_PROJECT]),
    });
    expect(p?.bytes).toBeNull();
    expect(formatBytes(null)).toBe('size unknown');
  });
});

describe('the probes read what docker actually prints', () => {
  test('docker ps -a distinguishes running from exited', () => {
    const parsed = parseComposeContainers(
      [
        ['p-postgres-1', 'scani_env_a_00000001', '/w/env_a/scani', 'running'].join('\t'),
        ['p-migrate-1', 'scani_env_a_00000001', '/w/env_a/scani', 'exited'].join('\t'),
        ['ab-testpg', '', '', 'running'].join('\t'),
      ].join('\n')
    );
    // The unlabelled container is dropped here rather than in the census: it
    // is not a compose project at all, so it has no project to belong to.
    expect(parsed).toHaveLength(2);
    expect(parsed.map((c) => c.running)).toEqual([true, false]);
  });

  test('an exited-only project is idle, not running', () => {
    const [p] = censusProjects({
      containers: [container({ project: GONE_PROJECT, workingDir: GONE_DIR, running: false })],
      volumes: [],
      liveProjects: new Set([LIVE_PROJECT]),
    });
    // Burning no CPU, still holding its name and blocking `volume rm`.
    expect(p?.state).toBe('gone-idle');
  });

  test('the cheap volume probe carries projects and no sizes', () => {
    const parsed = parseVolumeList(
      ['scani_env_a_00000001_postgres-data\tscani_env_a_00000001', 'anon-vol\t'].join('\n')
    );
    expect(parsed).toEqual([
      {
        name: 'scani_env_a_00000001_postgres-data',
        project: 'scani_env_a_00000001',
        sizeBytes: null,
      },
    ]);
  });

  test('df -v labels are a comma-joined string, not an object', () => {
    // Real shape, captured 2026-08-26. Sharing a parser with the `--format`
    // probe would silently yield zero projects here.
    const parsed = parseVolumeSizes(
      JSON.stringify([
        {
          Name: 'scani_env_a_00000001_postgres-data',
          Labels:
            'com.docker.compose.config-hash=d0f5,com.docker.compose.project=scani_env_a_00000001,com.docker.compose.volume=postgres-data',
          Size: '65.2MB',
        },
        { Name: 'anon', Labels: 'com.docker.volume.anonymous=', Size: '40.1MB' },
      ])
    );
    expect(parsed).toEqual([
      {
        name: 'scani_env_a_00000001_postgres-data',
        project: 'scani_env_a_00000001',
        sizeBytes: 65_200_000,
      },
    ]);
  });

  test('go-units sizes are base 1000', () => {
    expect(parseHumanSize('266B')).toBe(266);
    expect(parseHumanSize('65.2MB')).toBe(65_200_000);
    expect(parseHumanSize('1.73GB')).toBe(1_730_000_000);
  });

  test('malformed df JSON yields no volumes rather than throwing', () => {
    expect(parseVolumeSizes('not json')).toEqual([]);
    expect(parseVolumeSizes('{"not":"an array"}')).toEqual([]);
  });
});

describe('the down clause is silent unless there is something to say', () => {
  const liveProjects = new Set([LIVE_PROJECT]);

  test('silent when nothing is orphaned', () => {
    const projects = censusProjects({
      containers: [container({ project: LIVE_PROJECT, workingDir: LIVE_DIR })],
      volumes: [],
      liveProjects,
    });
    expect(orphanClause(projects, LIVE_PROJECT)).toBeNull();
  });

  test('silent about the project the caller just tore down', () => {
    const projects = censusProjects({
      containers: [],
      volumes: [volume(GONE_PROJECT)],
      liveProjects,
    });
    expect(orphanClause(projects, GONE_PROJECT)).toBeNull();
  });

  test('names the count and the command when orphans exist elsewhere', () => {
    const projects = censusProjects({
      containers: [],
      volumes: [volume(GONE_PROJECT)],
      liveProjects,
    });
    const clause = orphanClause(projects, LIVE_PROJECT);
    expect(clause).toContain('1 other compose project');
    expect(clause).toContain('bun run dev:stacks');
  });

  test('an idle LIVE checkout never triggers the clause', () => {
    // The whole point of keeping `live-idle` its own state.
    const projects = censusProjects({
      containers: [],
      volumes: [volume(LIVE_PROJECT)],
      liveProjects,
    });
    expect(orphanClause(projects, 'somebody-else')).toBeNull();
  });
});

describe('the report never prints one number a reader could reap from', () => {
  const census: MachineCensus = {
    blind: null,
    checkouts: 1,
    enumeration: { kind: 'enumerated', projects: new Set([LIVE_PROJECT]) },
    projects: censusProjects({
      containers: [container({ project: GONE_PROJECT, workingDir: GONE_DIR })],
      volumes: [volume(LIVE_PROJECT, 1_730_000_000), volume(GONE_PROJECT, 65_200_000)],
      liveProjects: new Set([LIVE_PROJECT]),
    }),
  };

  test('reclaimable and not-reclaimable are separate headings', () => {
    const text = formatCensus(census);
    expect(text).toContain('NO CHECKOUT OF THIS REPOSITORY');
    expect(text).toContain('NOT reclaimable');
    expect(text).toContain('Nothing was stopped or removed');
  });

  test('the report names the basis it judged against', () => {
    // Measured 2026-08-27: from a SEPARATE clone this census called six
    // projects unattributed when five had live worktrees, because
    // `git worktree list` there reports only itself. The number is what lets a
    // reader notice that, so it is asserted rather than left to the docblock.
    const text = formatCensus(census);
    expect(text).toContain('Attributed against the 1 checkout(s)');
    expect(text).toContain("separate clone's stack");
  });

  test('an unasked git makes the basis unknown, not a confident number', () => {
    expect(formatCensus({ ...census, checkouts: null })).toContain('unknown number of checkout(s)');
  });

  test('a blind probe is reported as blind, not as a clean machine', () => {
    const blind: MachineCensus = {
      projects: [],
      blind: { kind: 'unavailable', reason: 'no socket' },
      checkouts: null,
      enumeration: null,
    };
    const text = formatCensus(blind);
    expect(text).toContain('could not be asked');
    expect(text).not.toContain('no scani compose project');
  });

  test('an empty machine says so rather than printing nothing', () => {
    const empty: MachineCensus = {
      projects: [],
      blind: null,
      checkouts: 1,
      enumeration: { kind: 'enumerated', projects: new Set([LIVE_PROJECT]) },
    };
    expect(formatCensus(empty)).toContain('no scani compose project');
  });
});

describe('this is a reporter and stays one', () => {
  /**
   * The `setup/lib/container_owners.py` pattern: that file reports container
   * ownership and never selects, and its test fails if a threshold constant
   * ever appears in it. Same shape here against a removal verb — the point is
   * that turning this into a reaper has to be a deliberate act that deletes a
   * test, not a patch somebody lands while adding a flag.
   */
  const SOURCES = ['../lib/stack-census.ts', '../stacks.ts'];

  test('neither file can stop or remove what it enumerates', () => {
    for (const relative of SOURCES) {
      const source = readFileSync(path.join(import.meta.dir, relative), 'utf8');
      // Comments legitimately discuss removal, so only executable calls count.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const verb of ['rm', 'prune', 'stop', 'kill', 'down']) {
        expect(code).not.toMatch(new RegExp(`['"\`]${verb}['"\`]`));
      }
      expect(code).not.toMatch(/docker\s+(compose\s+)?(rm|down|stop|kill|prune)/);
    }
  });

  test('the guard can tell a reaper from a reporter', () => {
    // Without this the test above passes on a regex that stopped matching.
    const reaper = `spawnSync('docker', ['compose', '-p', project, 'down', '-v']);`;
    expect(reaper).toMatch(/['"`]down['"`]/);
  });
});
