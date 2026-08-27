import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  type DockerProbe,
  databaseFromUrl,
  databaseUrlFromEnv,
  parsePublishingContainer,
  resolveStackDb,
} from '../../apps/e2e/lib/stack-db';

/**
 * SC-494. `apps/e2e/fixtures/db.ts` answered "which database?" with two
 * constants, so a reused `bun dev:stack` — whose database is
 * `scani_dev_<label>_<hash>` (SC-429) — was queried at `scani`, which exists
 * and holds 0 tables.
 *
 * The property under test is NOT "the resolver works". It is that every way of
 * failing produces a REFUSAL NAMING THE STEP, and never a plausible target. A
 * constant is worse than no answer here: it is confidently wrong, and it is
 * wrong differently on each person's machine.
 */

const OK = (stdout: string) => ({ status: 0, stdout });
const FAIL = { status: 1, stdout: '' };

function probe(
  ps: { status: number; stdout: string },
  inspect: { status: number; stdout: string } = FAIL
): DockerProbe {
  return { containersPublishing: () => ps, environmentOf: () => inspect };
}

const API_CONTAINER = 'scani_env_abc_123-api-1';
const PS_LINE = `${API_CONTAINER}\tscani_env_abc_123\n`;
const ENV_DUMP = [
  'PATH=/usr/local/bin',
  'DATABASE_URL=postgres://scani:scani@postgres:5432/scani_dev_p5cekfpbyp_f4b19a5f?sslmode=disable',
  'NODE_ENV=production',
].join('\n');

describe('databaseFromUrl', () => {
  test('reads the path, not the tail — the query string is not part of the name', () => {
    // Every compose DATABASE_URL in this repo carries `?sslmode=disable`, so a
    // regex off the end would name `scani?sslmode=disable`.
    expect(databaseFromUrl('postgres://u:p@h:5432/scani_dev_x?sslmode=disable')).toBe(
      'scani_dev_x'
    );
  });

  test('plain url with no query string', () => {
    expect(databaseFromUrl('postgres://u:p@h:5432/scani')).toBe('scani');
  });

  test.each([
    ['not a url', 'this-is-not-a-url'],
    ['no database in the path', 'postgres://u:p@h:5432'],
    ['trailing slash only', 'postgres://u:p@h:5432/'],
  ])('refuses: %s', (_label, url) => {
    expect(databaseFromUrl(url)).toHaveProperty('error');
  });
});

describe('databaseUrlFromEnv', () => {
  test('finds DATABASE_URL among the rest', () => {
    expect(databaseUrlFromEnv(ENV_DUMP)).toContain('scani_dev_p5cekfpbyp_f4b19a5f');
  });

  test('a container with no DATABASE_URL is an error, not an empty string', () => {
    // An empty string would flow on and produce a query against `/`.
    expect(databaseUrlFromEnv('PATH=/usr/bin\nNODE_ENV=production')).toHaveProperty('error');
  });
});

describe('parsePublishingContainer', () => {
  test('takes the name and the compose project', () => {
    expect(parsePublishingContainer(PS_LINE)).toEqual({
      name: API_CONTAINER,
      project: 'scani_env_abc_123',
    });
  });

  test('nothing publishing the port is an error', () => {
    expect(parsePublishingContainer('')).toHaveProperty('error');
    expect(parsePublishingContainer('\n  \n')).toHaveProperty('error');
  });

  test('a container with no compose label is an error naming it', () => {
    // A hand-run `docker run -p` container answering the port. It is not part
    // of a compose project, so `<project>-postgres-1` cannot be derived.
    const result = parsePublishingContainer('some-container\t\n');
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toContain('some-container');
  });
});

describe('resolveStackDb — every failure names its step, none invents a target', () => {
  test('resolves container, database and project from a live stack', () => {
    // The must-be-FOUND control: every refusal assertion below passes against
    // a resolver that always errors. This one does not.
    expect(resolveStackDb(4611, probe(OK(PS_LINE), OK(ENV_DUMP)))).toEqual({
      container: 'scani_env_abc_123-postgres-1',
      database: 'scani_dev_p5cekfpbyp_f4b19a5f',
      project: 'scani_env_abc_123',
    });
  });

  test('docker unavailable', () => {
    const r = resolveStackDb(4611, probe(FAIL));
    expect(r).toHaveProperty('error');
    expect((r as { error: string }).error).toContain('4611');
  });

  test('nothing publishes the port — says an api answered anyway, so it is not a container', () => {
    // The host-side `bun dev` case. The message has to explain why the port is
    // live while docker sees nothing, or it reads as a docker fault.
    const r = resolveStackDb(4611, probe(OK('')));
    const message = (r as { error: string }).error;
    expect(message).toContain('bun dev');
  });

  test('inspect fails', () => {
    const r = resolveStackDb(4611, probe(OK(PS_LINE), FAIL));
    expect((r as { error: string }).error).toContain(API_CONTAINER);
  });

  test('container has no DATABASE_URL', () => {
    const r = resolveStackDb(4611, probe(OK(PS_LINE), OK('PATH=/usr/bin')));
    expect((r as { error: string }).error).toContain(API_CONTAINER);
  });

  test('DATABASE_URL is unparseable', () => {
    const r = resolveStackDb(4611, probe(OK(PS_LINE), OK('DATABASE_URL=nonsense')));
    expect(r).toHaveProperty('error');
  });

  test.each([
    ['docker unavailable', probe(FAIL)],
    ['nothing publishing', probe(OK(''))],
    ['inspect fails', probe(OK(PS_LINE), FAIL)],
    ['no DATABASE_URL', probe(OK(PS_LINE), OK('PATH=/usr/bin'))],
    ['unparseable url', probe(OK(PS_LINE), OK('DATABASE_URL=nonsense'))],
  ])('NEVER returns a usable target on failure: %s', (_label, p) => {
    // The whole point. A resolver that guessed on failure would satisfy every
    // "contains the right words" assertion above and still ship the bug.
    const r = resolveStackDb(4611, p);
    expect(r).not.toHaveProperty('container');
    expect(r).not.toHaveProperty('database');
  });
});

describe('the constants may not come back', () => {
  // Read as text for the same reason as `e2e-compose-project.test.ts`: the
  // property worth protecting is not that today's code is right, it is that a
  // fallback can never be added back — and only the source says that.
  const SOURCE = readFileSync(new URL('../../apps/e2e/fixtures/db.ts', import.meta.url), 'utf8');

  /**
   * Comments are stripped before matching, and that is not a convenience.
   * The file's header EXPLAINS the constants it removed, by name — so a guard
   * over the raw text fires on its own documentation, and the only ways to
   * make it pass are to delete the explanation or to weaken the pattern. Both
   * are worse than the guard. What must never come back is a constant the CODE
   * reads.
   */
  const FIXTURE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  test('the stripper leaves code intact — control for the four guards below', () => {
    // Without this, a stripper that returned '' would satisfy every
    // not-toContain assertion in this block.
    expect(FIXTURE).toContain('process.env.POSTGRES_CONTAINER');
    expect(FIXTURE).toContain('process.env.E2E_DB_NAME');
    expect(FIXTURE).toContain('docker');
  });

  test('no hardcoded database name', () => {
    expect(FIXTURE).not.toMatch(/DB_NAME\s*=\s*['"]scani['"]/);
  });

  test('no hardcoded container fallback', () => {
    // The literal that shipped: correct on one machine, silently wrong on
    // every other one.
    expect(FIXTURE).not.toContain('mgrin-e2e-suite-postgres-1');
  });

  test('no `??` default on either variable', () => {
    expect(FIXTURE).not.toMatch(/POSTGRES_CONTAINER\s*\?\?/);
    expect(FIXTURE).not.toMatch(/E2E_DB_NAME\s*\?\?/);
  });

  test('refusals say NO QUERY WAS MADE', () => {
    // Without it a reader assumes the query ran and returned nothing, which is
    // the same wrong conclusion by a shorter route.
    const refusals = FIXTURE.match(/throw new Error\(/g) ?? [];
    expect(refusals.length).toBeGreaterThanOrEqual(2);
    expect(FIXTURE.match(/NO QUERY WAS MADE/g)?.length).toBe(refusals.length);
  });

  test('a psql failure names the database it reached', () => {
    // SC-500's rule, one level down: a verdict with no provenance is what made
    // the original defect invisible.
    expect(FIXTURE).toMatch(/psql exited \$\{code\} against \$\{container\}\/\$\{database\}/);
  });
});

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
}
interface WorkflowJob {
  readonly env?: Record<string, string>;
  readonly steps?: readonly WorkflowStep[];
}

describe('every CI step that runs the suite supplies the database the fixture refuses to guess', () => {
  /**
   * SC-494's own regression, written as a DISJUNCTION rather than as an
   * assertion about one job — and the difference is the whole point.
   *
   * `apps/e2e/fixtures/db.ts` has no fallbacks left: it needs
   * `POSTGRES_CONTAINER` and `E2E_DB_NAME`, and refuses with NO QUERY WAS MADE
   * when either is absent. Exactly two things can supply them —
   * `apps/e2e/scripts/run.ts`, which discovers the running stack and exports
   * both, or the workflow itself where it bypasses that runner and invokes the
   * binary directly. So what a workflow must satisfy is "every step that runs
   * the suite does one or the other".
   *
   * The first version of this guard asserted the second half only, because
   * that is what the mirror's workflow does. This file is oss-eligible, so the
   * two copies must be byte-identical — and the private workflow has no such
   * step at all: it runs `bun run test:e2e:a11y`, which goes through the
   * runner. Measured on the port: 27 pass, 3 fail, all three of them this
   * guard, against a workflow that was never wrong. A guard that can only be
   * true in one of the two trees it is required to be identical in is not a
   * stricter guard, it is a broken one.
   *
   * The mirror's CI is the only CI this project has (the private repo is
   * billing-blocked), and the e2e suite is not part of `bun run test`, so no
   * local gate reaches the job itself. A source guard is the only check that
   * runs where the defect lives.
   */
  const WORKFLOW = Bun.YAML.parse(
    readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  ) as { readonly jobs?: Record<string, WorkflowJob> };

  // Read as text: this asserts the runner still SETS them, which is the only
  // reason delegating to it is safe. `import`ing it would boot the orchestrator.
  const RUNNER = readFileSync(new URL('../../apps/e2e/scripts/run.ts', import.meta.url), 'utf8');

  const suiteSteps = Object.entries(WORKFLOW.jobs ?? {}).flatMap(([jobId, job]) =>
    (job.steps ?? [])
      .filter((step) => typeof step.run === 'string' && /playwright test|test:e2e/.test(step.run))
      .map((step) => ({ jobId, job, step }))
  );

  test('the workflow runs the suite at all', () => {
    // The control, and it is not a formality: every assertion below is
    // generated from `suiteSteps`, so an empty list means this describe block
    // reports a clean pass having checked nothing. That is the exact shape
    // this file exists to refuse.
    expect(suiteSteps.length).toBeGreaterThan(0);
  });

  for (const { jobId, job, step } of suiteSteps) {
    const run = step.run as string;
    const viaRunner = /scripts\/run\.ts|test:e2e/.test(run);

    test(`\`${jobId} > ${step.name ?? run.trim()}\` gets the target from the runner or from its own env`, () => {
      if (viaRunner) {
        // Matched as an ASSIGNMENT, not as a substring. `toContain` was the
        // first attempt and a mutant walked straight through it: renaming the
        // variable to `E2E_DB_NAMEX` left the guard green, because
        // `E2E_DB_NAMEX` contains `E2E_DB_NAME`.
        expect(RUNNER).toMatch(/SERVICE_ENV\.POSTGRES_CONTAINER\s*=/);
        expect(RUNNER).toMatch(/SERVICE_ENV\.E2E_DB_NAME\s*=/);
        return;
      }

      // GitHub's own precedence: a step's env wins over its job's.
      const env = { ...job.env, ...step.env };
      expect(Object.keys(env)).toContain('POSTGRES_CONTAINER');
      expect(Object.keys(env)).toContain('E2E_DB_NAME');

      // Two copies of the project name is how the pair drifts apart later.
      expect(env.POSTGRES_CONTAINER).toBe('${{ env.COMPOSE_PROJECT_NAME }}-postgres-1');

      // …and a derivation is worth nothing if the name it reads is unset: the
      // assertion above passes just as happily against a job that interpolates
      // an empty string and asks docker for `-postgres-1`.
      expect(job.env?.COMPOSE_PROJECT_NAME ?? '').not.toBe('');
    });
  }
});
