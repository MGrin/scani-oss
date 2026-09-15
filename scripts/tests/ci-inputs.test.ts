import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildkitePathGates,
  filtersMatching,
  type GatedJob,
  gatedJobs,
  inputsOf,
  type JobInputs,
  type PipelineFile,
  type RepoView,
  uncoveredInputs,
  type WorkflowFile,
} from '../lib/ci-inputs';

/**
 * SC-1161. A path-filtered job must be able to see every file it consumes.
 *
 * `docker-compose.yml` matched no filter, so the pull request repairing the
 * compose stack skipped the E2E job that starts it, and `CI Success` read the
 * skip as a pass (SC-1156). This file is the class, not the instance: it
 * derives what each gated job reads from the commands it runs
 * (`scripts/lib/ci-inputs.ts`) and fails on any consumed file the job's gate
 * cannot see — including a new FILE TYPE under a directory a filter enumerates
 * by extension, which is how the gap recurs.
 *
 * WHICH CI IT AUDITS DEPENDS ON THE CHECKOUT, and both halves assert. The
 * mirror's CI is GitHub Actions. The private repository's Actions is retired by
 * owner decision (SC-1169) — its workflows never run, so their filters gate
 * nothing — and its CI is Buildkite, which must stay free of path gates.
 */

const ROOT = new URL('../..', import.meta.url).pathname;

function trackedFiles(): string[] {
  const out = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' });
  if (out.status !== 0) throw new Error(`NOTHING WAS READ: git ls-files failed: ${out.stderr}`);
  return out.stdout.split('\n').filter(Boolean);
}

const FILES = trackedFiles();
const TRACKED = new Set(FILES);
const REPO: RepoView = {
  files: FILES,
  read: (path) => (TRACKED.has(path) ? readFileSync(join(ROOT, path), 'utf8') : null),
};
const WORKFLOWS: WorkflowFile[] = FILES.filter((f) =>
  /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f)
).map((path) => ({ path, text: REPO.read(path) as string }));
const PIPELINES: PipelineFile[] = FILES.filter(
  (f) =>
    /^docs\/ci\/[^/]+\.pipeline\.yml$/.test(f) ||
    /^infra\/buildkite\/pipelines\/[^/]+\.yml$/.test(f)
).map((path) => ({ path, text: REPO.read(path) as string }));

/** A Buildkite pipeline of record means Actions is not this checkout's CI (SC-1169). */
const ACTIONS_IS_CI = PIPELINES.length === 0;

/**
 * A consumed tree a job's own gate does not see, accepted ONLY because another
 * job proves it (owner decision, SC-1161). `coveredBy` must build the SAME
 * Dockerfile at the SAME target, and its own gate must see every file of the
 * tree. Both are recomputed on every run by `proofOf`, so a change to either
 * job's filter or build target turns the exemption red rather than stale.
 */
interface Exemption {
  readonly workflow: string;
  readonly job: string;
  readonly tree: string;
  readonly coveredBy: { workflow: string; job: string };
  readonly why: string;
}

const EXEMPTIONS: readonly Exemption[] = [
  ...['apps/backend/api/', 'packages/'].map((tree) => ({
    workflow: '.github/workflows/ci.yml',
    job: 'prod-guards-integration',
    tree,
    coveredBy: { workflow: '.github/workflows/ci.yml', job: 'e2e' },
    why: 'the job exists to boot the compiled api under production guards; a change that breaks building that image is caught by E2E, whose `bun dev:stack` builds the same Dockerfile at the same final stage on every change its gate sees',
  })),
  ...['apps/backend/api/', 'apps/backend/data-provider/', 'apps/backend/worker/', 'packages/'].map(
    (tree) => ({
      workflow: '.github/workflows/docker-publish.yml',
      job: 'build',
      tree,
      coveredBy: { workflow: '.github/workflows/ci.yml', job: 'e2e' },
      why: "a pull request's image build is a build check; E2E builds the api, worker and data-provider Dockerfiles at the same final stage on every change its gate sees",
    })
  ),
];

/**
 * The one gap no job closes, accepted as the workflow's stated design rather
 * than proven by another job (owner decision, SC-1161). It is pinned to two
 * Dockerfiles and two trees, and the workflow must still state the design and
 * the gap, so the skip can neither widen to another image nor outlive its reason.
 */
const DECLARED = {
  workflow: '.github/workflows/docker-publish.yml',
  job: 'build',
  dockerfiles: ['apps/frontend/app/Dockerfile', 'packages/infra/db/Dockerfile.migrate'],
  trees: ['apps/frontend/app/', 'packages/'],
  design:
    'Code-only and docs-only PRs skip the 4× build entirely. The next `v*` tag push will still rebuild and publish everything, so the PR build is purely a smoke test.',
  uncovered:
    'a source change that breaks the app or migrate image build is first caught at the next `v*` tag publish, not on the PR',
} as const;

/** True when every image build that consumes `tree` is one the declared gap names. */
function declaredOnly(job: GatedJob, tree: string, inputs: JobInputs): boolean {
  if (job.workflow !== DECLARED.workflow || job.jobId !== DECLARED.job) return false;
  if (!(DECLARED.trees as readonly string[]).includes(tree)) return false;
  const builds = inputs.builds.filter((b) => b.trees.includes(tree));
  return (
    builds.length > 0 &&
    builds.every((b) => (DECLARED.dockerfiles as readonly string[]).includes(b.dockerfile))
  );
}

const JOBS = gatedJobs(WORKFLOWS);
const INPUTS = new Map<GatedJob, JobInputs>(
  JOBS.map((job) => [job, inputsOf(job, REPO, WORKFLOWS)])
);

const key = (job: GatedJob) =>
  `${job.workflow.replace('.github/workflows/', '')}#${job.jobId}${
    job.gate.kind === 'on-paths' ? ` (on.${job.gate.event}.paths)` : ''
  }`;

/** Why an exemption holds, or the sentence saying it no longer does. */
function proofOf(
  exemption: Exemption,
  jobs: readonly GatedJob[],
  inputs: Map<GatedJob, JobInputs>
): string | null {
  const own = jobs.filter((j) => j.workflow === exemption.workflow && j.jobId === exemption.job);
  const cover = jobs.find(
    (j) => j.workflow === exemption.coveredBy.workflow && j.jobId === exemption.coveredBy.job
  );
  if (own.length === 0) return `no gated job ${exemption.workflow}#${exemption.job}`;
  if (!cover)
    return `the covering job ${exemption.coveredBy.job} is no longer gated or no longer exists`;
  const coverInputs = inputs.get(cover) as JobInputs;
  for (const job of own) {
    // The declared images are accepted by DECLARED, not by this proof, so they are not asked to match.
    const builds = (inputs.get(job) as JobInputs).builds.filter(
      (b) =>
        b.trees.includes(exemption.tree) &&
        !(
          job.workflow === DECLARED.workflow &&
          job.jobId === DECLARED.job &&
          (DECLARED.dockerfiles as readonly string[]).includes(b.dockerfile)
        )
    );
    if (builds.length === 0)
      return `${key(job)} no longer consumes ${exemption.tree} through an image build`;
    for (const build of builds) {
      const same = coverInputs.builds.some(
        (b) =>
          b.dockerfile === build.dockerfile &&
          b.target === build.target &&
          b.trees.includes(exemption.tree)
      );
      if (!same) {
        return `${key(cover)} does not build ${build.dockerfile} at target ${build.target ?? '(final)'} over ${exemption.tree}`;
      }
    }
  }
  const unseen = uncoveredInputs(cover, coverInputs, REPO).filter((g) =>
    g.path.startsWith(exemption.tree)
  );
  if (unseen.length > 0) {
    return `${key(cover)}'s gate does not see ${unseen.length} file(s) under ${exemption.tree}, e.g. ${unseen[0]?.path}`;
  }
  return null;
}

function unexplainedGaps(jobs: readonly GatedJob[], inputs: Map<GatedJob, JobInputs>): string[] {
  const out: string[] = [];
  for (const job of jobs) {
    const proven = EXEMPTIONS.filter(
      (e) => e.workflow === job.workflow && e.job === job.jobId && proofOf(e, jobs, inputs) === null
    ).map((e) => e.tree);
    const own = inputs.get(job) as JobInputs;
    for (const gap of uncoveredInputs(job, own, REPO)) {
      if (proven.some((tree) => gap.path.startsWith(tree))) continue;
      if (gap.via !== null && declaredOnly(job, gap.via, own)) continue;
      out.push(`${key(job)}: ${gap.path}${gap.via ? ` (via ${gap.via || '.'})` : ''}`);
    }
  }
  return out;
}

describe('SC-1161 — which CI this checkout runs', () => {
  test('exactly one of Actions and Buildkite is audited as CI here', () => {
    if (ACTIONS_IS_CI) {
      // The mirror. A tree with no gated job would pass every test below.
      expect(JOBS.length).toBeGreaterThan(0);
    } else {
      expect(PIPELINES.length).toBeGreaterThan(0);
    }
  });
});

describe('SC-1161 — Buildkite skips nothing on what changed', () => {
  test('no pipeline step is gated on the diff', () => {
    expect(buildkitePathGates(PIPELINES)).toEqual([]);
  });

  test('control: an if_changed step and a diff-reading command are both found', () => {
    const planted: PipelineFile = {
      path: 'planted.yml',
      text: [
        'steps:',
        '  - key: e2e',
        '    command: bun run test',
        '    if_changed: "apps/**"',
        '  - group: g',
        '    steps:',
        '      - key: lint',
        '        command: "git diff --name-only origin/main | grep -q ts || exit 0"',
      ].join('\n'),
    };
    expect(buildkitePathGates([planted])).toEqual([
      'planted.yml#e2e: if_changed',
      'planted.yml#lint: command reads the diff',
    ]);
  });
});

describe.if(ACTIONS_IS_CI)('SC-1161 — every gated Actions job sees what it consumes', () => {
  test('every command a gated job runs resolves to its inputs', () => {
    const unresolved = JOBS.flatMap((job) =>
      (INPUTS.get(job) as JobInputs).unresolved.map((cmd) => `${key(job)}: ${cmd}`)
    );
    expect(unresolved).toEqual([]);
  });

  test('every consumed file reaches the gate of the job that consumes it', () => {
    expect(unexplainedGaps(JOBS, INPUTS)).toEqual([]);
  });

  test('every exemption is still proven by the job it names', () => {
    const broken = EXEMPTIONS.map((e) => [e, proofOf(e, JOBS, INPUTS)] as const)
      .filter(([, why]) => why !== null)
      .map(([e, why]) => `${e.job} ${e.tree}: ${why}`);
    expect(broken).toEqual([]);
  });

  test('the denominator: what was checked, not only what failed', () => {
    const rows = JOBS.map((job) => {
      const inputs = INPUTS.get(job) as JobInputs;
      const consumed =
        inputs.files.length +
        inputs.trees.reduce((n, tree) => n + FILES.filter((f) => f.startsWith(tree)).length, 0);
      return `${key(job)}: ${consumed} consumed file(s), ${inputs.builds.length} image build(s), ${job.globs.length} glob(s)`;
    });
    console.log(
      `SC-1161 audit\n  ${rows.join('\n  ')}\n  declared, not covered: ${DECLARED.uncovered} (${DECLARED.dockerfiles.join(', ')})`
    );
    expect(rows.length).toBe(JOBS.length);
  });

  test('control, must-be-FOUND: dropping docker-compose from the filters leaves E2E blind to it', () => {
    const ci = WORKFLOWS.find((w) => w.path === '.github/workflows/ci.yml') as WorkflowFile;
    const mutated = WORKFLOWS.map((w) =>
      w === ci ? { ...w, text: w.text.replace(/^\s*- 'docker-compose\*\.yml'\n/gm, '') } : w
    );
    expect(mutated.find((w) => w.path === ci.path)?.text).not.toBe(ci.text);
    const jobs = gatedJobs(mutated);
    const inputs = new Map(jobs.map((job) => [job, inputsOf(job, REPO, mutated)]));
    expect(unexplainedGaps(jobs, inputs)).toContain('ci.yml#e2e: docker-compose.yml');
  });

  test('control, must-SKIP: a change to the root README opens no E2E gate', () => {
    // Without this arm, "trigger everything on everything" passes the tests
    // above and the filters stop meaning anything.
    const opened = filtersMatching('README.md', WORKFLOWS).map((m) => m.jobId);
    expect(opened).not.toContain('e2e');
    expect(filtersMatching('docker-compose.yml', WORKFLOWS).map((m) => m.jobId)).toContain('e2e');
  });

  test('the declared gap names two images, two trees, and still states its reason in the workflow', () => {
    expect(DECLARED.dockerfiles).toEqual([
      'apps/frontend/app/Dockerfile',
      'packages/infra/db/Dockerfile.migrate',
    ]);
    expect(DECLARED.trees).toEqual(['apps/frontend/app/', 'packages/']);
    const prose = (REPO.read(DECLARED.workflow) ?? '')
      .split('\n')
      .filter((line) => /^\s*#/.test(line))
      .map((line) => line.replace(/^\s*#\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(prose).toContain(DECLARED.design);
    expect(prose).toContain(DECLARED.uncovered);
  });

  test('control: the declared gap does not reach an image E2E builds', () => {
    const ci = WORKFLOWS.find((w) => w.path === '.github/workflows/ci.yml') as WorkflowFile;
    const mutated = WORKFLOWS.map((w) =>
      w === ci
        ? {
            ...w,
            text: w.text.replace(/^(\s*e2e:\n(?:\s*- '[^']*'\n)*?)\s*- 'packages\/\*\*'\n/m, '$1'),
          }
        : w
    );
    expect(mutated.find((w) => w.path === ci.path)?.text).not.toBe(ci.text);
    const jobs = gatedJobs(mutated);
    const inputs = new Map(jobs.map((job) => [job, inputsOf(job, REPO, mutated)]));
    const publish = unexplainedGaps(jobs, inputs).filter((g) =>
      g.startsWith('docker-publish.yml#build')
    );
    expect(publish.some((g) => g.includes('(via packages/)'))).toBe(true);
  });

  test('control: a step no resolver knows is reported, not ignored', () => {
    const ci = WORKFLOWS.find((w) => w.path === '.github/workflows/ci.yml') as WorkflowFile;
    const mutated = WORKFLOWS.map((w) =>
      w === ci ? { ...w, text: w.text.replace(/run: bun run test\b/, 'run: make everything') } : w
    );
    const job = gatedJobs(mutated).find((j) => j.jobId === 'test') as GatedJob;
    expect(inputsOf(job, REPO, mutated).unresolved).toContain('make everything');
  });
});

describe('SC-1161 — the derivation, on a fixture tree', () => {
  const fixture = (files: Record<string, string>): RepoView => ({
    files: Object.keys(files),
    read: (path) => files[path] ?? null,
  });
  const workflow = (filter: string, run: string): WorkflowFile => ({
    path: '.github/workflows/ci.yml',
    text: [
      'on: { pull_request: {} }',
      'jobs:',
      '  changes:',
      `    outputs: { code: "\${{ steps.f.outputs.code }}" }`,
      '    steps:',
      '      - id: f',
      '        uses: dorny/paths-filter@v3',
      '        with:',
      '          filters: |',
      '            code:',
      `              - '${filter}'`,
      '  test:',
      `    if: \${{ needs.changes.outputs.code == 'true' }}`,
      '    steps:',
      `      - run: ${run}`,
    ].join('\n'),
  });
  const gaps = (repo: RepoView, wf: WorkflowFile) => {
    const [job] = gatedJobs([wf]);
    return uncoveredInputs(job as GatedJob, inputsOf(job as GatedJob, repo, [wf]), repo).map(
      (g) => g.path
    );
  };

  test('a test root filtered by extension misses the fixture it reads', () => {
    const repo = fixture({
      'pkg/a.test.ts': '',
      'pkg/fixtures/statement.csv': '',
      'bunfig.toml': '',
    });
    expect(gaps(repo, workflow('pkg/**/*.ts', 'bun test pkg/'))).toEqual([
      '.github/workflows/ci.yml',
      'bunfig.toml',
      'pkg/fixtures/statement.csv',
    ]);
    const whole = workflow('**', 'bun test pkg/');
    expect(gaps(repo, whole)).toEqual([]);
  });

  test('a Dockerfile built by compose contributes what it copies', () => {
    const repo = fixture({
      'docker-compose.yml':
        'services:\n  api:\n    build:\n      context: .\n      dockerfile: api/Dockerfile\n',
      'api/Dockerfile': 'FROM x\nCOPY api ./api\nCOPY --from=build /out /out\n',
      'api/main.ts': '',
      'api/schema.sql': '',
    });
    const wf = workflow('api/**/*.ts', 'docker compose up --build');
    const [job] = gatedJobs([wf]);
    const inputs = inputsOf(job as GatedJob, repo, [wf]);
    expect(inputs.builds).toEqual([
      {
        dockerfile: 'api/Dockerfile',
        target: null,
        context: '',
        files: ['api/Dockerfile'],
        trees: ['api/'],
      },
    ]);
    expect(gaps(repo, wf)).toContain('api/schema.sql');
    expect(gaps(repo, wf)).toContain('docker-compose.yml');
  });

  test('a cp source is an input', () => {
    const repo = fixture({ '.env.example': 'X=1' });
    expect(gaps(repo, workflow('src/**', 'cp .env.example .env'))).toContain('.env.example');
  });

  test("a script's imports are inputs even behind a shebang, and an unparseable one is reported", () => {
    const repo = fixture({
      'tools/up.ts': "#!/usr/bin/env bun\nimport { x } from './lib/ports';\nx();\n",
      'tools/lib/ports.ts': 'export const x = () => 1;\n',
      'tools/broken.ts': 'import {{ nope',
    });
    expect(gaps(repo, workflow('tools/up.ts', 'bun tools/up.ts'))).toContain('tools/lib/ports.ts');
    const [job] = gatedJobs([workflow('tools/**', 'bun tools/broken.ts')]);
    expect(
      inputsOf(job as GatedJob, repo, [workflow('tools/**', 'bun tools/broken.ts')]).unresolved
    ).toEqual(['import graph unreadable: tools/broken.ts']);
  });
});
