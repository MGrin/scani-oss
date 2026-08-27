import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  API_SERVICE_ALIASES,
  BOOT_SERVICES,
  ONE_SHOT_SERVICES,
  resolveApiService,
} from '../../apps/e2e/scripts/run.ts';

/**
 * SC-725. `apps/e2e/scripts/run.ts` is executed by no CI that runs, so a
 * resolution bug in it ships silently and stays shipped.
 *
 * Both halves are measured, 2026-08-28:
 *
 *   PRIVATE   job `e2e-a11y` runs `bun run test:e2e:a11y`, which is this
 *             runner — but every job in the private `ci.yml` dies at zero
 *             steps under the Actions billing block (SC-128, SC-433), so it
 *             never starts.
 *   UPSTREAM  job `e2e` runs `bunx playwright test` DIRECTLY and says so in
 *             its own comment: it bypasses the orchestrator so the cache and
 *             artifact steps can sit between stack-up and the test run.
 *
 * So the two repos reimplement boot / wait / run / teardown independently, and
 * the implementation that is SHARED is the one nothing executes. That is not a
 * hypothetical: the runner shipped `no such service: backend` from the day it
 * was written — a literal that could only ever be right in one of the two
 * repos — and nothing anywhere went red for its entire life (SC-496).
 *
 * THE GATE CANNOT REACH IT EITHER. `package.json`'s `test` script walks
 * `packages/ apps/backend/ apps/frontend/ scripts/`; `apps/e2e/` is in none of
 * them and holds zero `*.test.ts`. `scripts/tests/` is the one directory that
 * runs in BOTH the private local gate and upstream CI's `test` job, which is
 * why this file lives here and imports upward rather than sitting beside its
 * subject.
 *
 * WHAT THIS FILE DOES NOT DO. It does not boot a stack, and it must not: a
 * check that needs Docker is a check that fails on a machine without it, and
 * CLAUDE.md's reasoning for keeping the visual gate out of the main gate
 * applies unchanged. What is testable without a stack is the RESOLUTION — the
 * service names, the alias pick, the refusal message — and resolution is
 * precisely where this runner has actually broken.
 *
 * POPULATION, and the direction it errs in. `declaredServices` below parses
 * the tracked `docker-compose.yml`. The runner asks `docker compose config
 * --services`, which additionally merges an untracked
 * `docker-compose.override.yml` (gitignored, `.gitignore:45`) when a developer
 * has one. So this file's population is a SUBSET of the runner's. The
 * consequence is one-directional and is the safe direction: a name supplied
 * only by someone's local override would read here as MISSING — a false red
 * that names itself — and a name compose does not declare can never read here
 * as present. It cannot produce a false green on the defect it exists for.
 */

/**
 * Parsed, not grepped. The question is structural — *does this compose file
 * declare a service by this name* — and a `grep` for `mailpit` matches the
 * word in a comment, a volume name or a `depends_on` entry equally well. The
 * sibling guard `compose-urls-follow-ports.test.ts` reads the same file as
 * TEXT for the opposite and equally deliberate reason: it is protecting an
 * UNRESOLVED `${VAR}` that parsing would resolve away.
 */
const COMPOSE = new URL('../../docker-compose.yml', import.meta.url);
const DECLARED: readonly string[] = Object.keys(
  (
    Bun.YAML.parse(readFileSync(COMPOSE, 'utf8')) as {
      services?: Record<string, unknown>;
    }
  )?.services ?? {}
);

/**
 * A name no compose file in either repo declares, used as the must-be-ABSENT
 * arm below. Assembled rather than written as one literal so this file cannot
 * satisfy a future text-scanning guard against itself — the reason
 * `check-oss-internal-refs.ts` gives for the same trick.
 */
const NOT_A_SERVICE = `sc725-${'absent'}-service`;

describe('SC-725 · the e2e runner asks for services this repo actually declares', () => {
  /**
   * THE CONTROL, on both axes, and it is load-bearing rather than ceremony.
   *
   * Every assertion below is of the form "each name in list L is in DECLARED".
   * That is vacuously true when L is empty, and it is *also* satisfied by a
   * DECLARED set so large it contains everything — so one arm is not enough.
   * The must-be-FOUND half proves the parse produced services at all; the
   * must-be-ABSENT half proves membership can come out false, which is the
   * inequality case an equality test needs before any of its passes mean
   * anything.
   */
  test('the compose file parses, and membership can come out false', () => {
    expect(DECLARED.length).toBeGreaterThan(0);
    expect(DECLARED).toContain('postgres');
    expect(DECLARED).not.toContain(NOT_A_SERVICE);
    expect(BOOT_SERVICES.length).toBeGreaterThan(0);
    expect(ONE_SHOT_SERVICES.length).toBeGreaterThan(0);
  });

  /**
   * The list handed to `docker compose up`. This is the assertion that would
   * have gone red on the `backend` literal on the day it was written, in
   * whichever repo it was wrong in — and it travels with the test rather than
   * with either copy of the compose file, so it asks each repo about its own.
   */
  test('every service the runner boots is declared here', () => {
    for (const service of BOOT_SERVICES) {
      expect({ service, declared: DECLARED }).toMatchObject({
        declared: expect.arrayContaining([service]),
      });
    }
  });

  /**
   * The `depends_on` gates the runner dumps logs from when a boot fails. A
   * stale name here is quieter than a stale `BOOT_SERVICES` one: the run does
   * not fail, the diagnostic dump is simply empty — so the operator meets
   * SC-496's original symptom, an undiagnosable boot, at the exact moment the
   * dump exists to prevent it.
   */
  test('every one-shot service the runner dumps logs from is declared here', () => {
    for (const service of ONE_SHOT_SERVICES) {
      expect({ service, declared: DECLARED }).toMatchObject({
        declared: expect.arrayContaining([service]),
      });
    }
  });

  /**
   * EXACTLY one, not at least one. `resolveApiService` takes the FIRST alias
   * it finds, so a repo declaring both `api` and `backend` would silently get
   * whichever is listed first in `API_SERVICE_ALIASES` — a choice nobody made,
   * invisible in every output. Zero is SC-496's original bug.
   */
  test('this repo declares exactly one of the api aliases', () => {
    const matches = API_SERVICE_ALIASES.filter((alias) => DECLARED.includes(alias));
    expect(matches).toHaveLength(1);
  });
});

describe('SC-725 · resolveApiService, the half that used to be unreachable', () => {
  test('it picks the alias this repo declares', () => {
    expect(resolveApiService(DECLARED)).toEqual({
      service: API_SERVICE_ALIASES.filter((a) => DECLARED.includes(a))[0] as string,
    });
  });

  /** Both spellings resolve, so neither repo depends on the other's compose file. */
  test('either repo spelling resolves against its own service list', () => {
    expect(resolveApiService(['postgres', 'api', 'worker'])).toEqual({ service: 'api' });
    expect(resolveApiService(['postgres', 'backend', 'worker'])).toEqual({ service: 'backend' });
  });

  /**
   * The refusal is asserted on its PROPERTIES, never on its exact prose.
   * SC-729 is the case against the alternative: `schema-drift.test.ts` pinned
   * an operator-facing sentence verbatim, so the wrong text was ENFORCED and
   * anyone correcting it went red on their own change. What this message must
   * do is name what was looked for and what was found; how it says so is free.
   */
  test('with no alias declared it refuses, naming both sides', () => {
    const resolved = resolveApiService(['postgres', 'redis', 'mailpit']);
    expect(resolved).not.toHaveProperty('service');
    const { error } = resolved as { error: string };
    for (const alias of API_SERVICE_ALIASES) expect(error).toContain(alias);
    expect(error).toContain('postgres');
  });

  /**
   * The state that produced SC-496's undiagnosable failure: `composeCapture`
   * returns `''` when the docker call itself failed, so `declared` is empty.
   * A docker that is not running must not read as "this repo declares no api"
   * — the message has to distinguish them, and that distinction is the whole
   * reason the empty case gets its own clause.
   */
  test('an empty service list says the command failed, not that the repo has no api', () => {
    const resolved = resolveApiService([]);
    expect(resolved).not.toHaveProperty('service');
    expect((resolved as { error: string }).error).toContain('the command above failed');
  });
});
