import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  composeInterpolates,
  defaultProfileInterpolations,
  defaultProfileLongRunning,
  downArgs,
  downVerdict,
  parseMode,
  publishedServices,
  stackEnv,
  upArgs,
  upVerdict,
} from '../dev-stack';
import {
  composeProjectName,
  devDatabaseName,
  isPrimaryCheckout,
  OFFSET_SLOTS,
  OFFSET_STEP,
  portOffset,
  STACK_SERVICES,
  stackPorts,
  worktreeIdentity,
} from '../lib/worktree';

/**
 * SHARED BETWEEN BOTH SCANI REPOSITORIES, byte-identical (SC-497). Every
 * assertion below has to hold in a tree whose `docker-compose.yml` publishes
 * only some of `STACK_SERVICES` — that is why two of them read the compose
 * file for the set to check rather than sweeping the whole list. The sweeps
 * live beside each repo's own compose file.
 *
 * SC-491. Two worktrees could not run `bun dev:stack` at once, and the half
 * that cost something was silent: compose identifies a container by project +
 * service, the project name defaults to the directory leaf, and every bb
 * worktree's leaf is `scani` — so the second `up` adopted and recreated the
 * first's containers rather than failing.
 */
describe('a compose project name isolates one worktree from another', () => {
  /**
   * Synthetic on purpose (SC-566), and see the longer note further down about
   * why these three stay literals while `WORKTREE` cannot: they feed pure
   * string functions that never look at the filesystem, so a path that does
   * not exist is a perfectly good input — and a path that does exist today is
   * a latent failure waiting for SC-530 to reap it.
   */
  const A = '/fixture/worktrees/env_fixture01/scani';
  const B = '/fixture/worktrees/env_fixture02/scani';
  const C = '/fixture/checkouts/primary/scani';

  test('every worktree gets a different project', () => {
    expect(new Set([A, B, C].map(composeProjectName)).size).toBe(3);
  });

  test('the same worktree gets the same project every time', () => {
    // A stack you come back to tomorrow has to be the same stack. Anything
    // per-run (a pid, a timestamp) would strand yesterday's containers.
    expect(composeProjectName(A)).toBe(composeProjectName(`${A}/`));
  });

  test('the name is legal for compose and readable in `docker ps`', () => {
    for (const p of [A, B, C, '/tmp/Weird Name (2)/scani', '/x/ÜNICODE/scani', '/scani']) {
      expect(composeProjectName(p)).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    }
    expect(composeProjectName(A)).toContain('env_fixture01');
  });

  test('the project and the database of one worktree share a suffix', () => {
    // So `docker ps` and `\l` in psql can be read against each other.
    //
    // Asserted on the two pure functions rather than through `stackEnv`,
    // because `A` names a worktree that no longer exists and `stackEnv` also
    // derives PORTS, which shells out with the path as `cwd` (SC-563). The
    // property here is about NAMES, and both functions that produce them are
    // string transforms — so the fixture may stay a literal, which is the
    // point of having three of them.
    for (const p of [A, B, C]) {
      expect(devDatabaseName(p)).toBe(`scani_dev_${composeProjectName(p).slice('scani_'.length)}`);
    }
  });

  test('stackEnv emits that pair, not two separately-derived names', () => {
    // The half the pure-function check above cannot see: `stackEnv` could
    // agree with neither and still leave those two functions consistent.
    // Uses this checkout, because `stackEnv` reads the filesystem.
    //
    // An EXPLICIT empty environment, not the ambient one (SC-497). Since these
    // names honour an operator's choice, reading `process.env` here would make
    // the assertion depend on whether whoever ran the suite had exported a
    // `COMPOSE_PROJECT_NAME` — green on one machine and red on another, for a
    // reason that has nothing to do with the derivation being tested.
    const here = resolve(import.meta.dir, '..', '..');
    const env = stackEnv(here, {});
    expect(env.COMPOSE_PROJECT_NAME).toBe(composeProjectName(here));
    expect(env.SCANI_DEV_DB).toBe(devDatabaseName(here));
  });

  test('a name the operator set wins over the derived one', () => {
    // SC-497. `resolveStackPorts` already lets a `<SERVICE>_HOST_PORT` win and
    // these three names did not — the identical defect with a different
    // variable, and worse than being ignored: `run()` spreads the derived
    // value OVER `process.env`, so an exported name was replaced silently.
    //
    // Found by upstream CI, which exports `COMPOSE_PROJECT_NAME` for its E2E
    // job and reaches containers by that name. Every database assertion failed
    // with `No such container` against a stack that had started perfectly.
    const here = resolve(import.meta.dir, '..', '..');
    const asked = stackEnv(here, {
      COMPOSE_PROJECT_NAME: 'mgrin-e2e-suite',
      SCANI_STACK_TAG: 'pinned',
      SCANI_DEV_DB: 'someone_elses_db',
    });
    expect(asked.COMPOSE_PROJECT_NAME).toBe('mgrin-e2e-suite');
    expect(asked.SCANI_STACK_TAG).toBe('pinned');
    expect(asked.SCANI_DEV_DB).toBe('someone_elses_db');
  });

  test('an empty or whitespace name is not a choice', () => {
    // Matching `stackPortOverrides`. An exported-but-empty variable is the
    // shape a shell produces from an unset value, and taking it literally
    // would name the compose project the empty string — at which point compose
    // falls back to the directory leaf and SC-491 is back, from a variable
    // nobody thinks they set.
    const here = resolve(import.meta.dir, '..', '..');
    for (const blank of ['', '   ']) {
      expect(stackEnv(here, { COMPOSE_PROJECT_NAME: blank }).COMPOSE_PROJECT_NAME).toBe(
        composeProjectName(here)
      );
    }
  });
});

describe('published ports of two worktrees can never overlap', () => {
  /**
   * The reason offsets step by 100 and stop at 2000: no two base ports differ
   * by a multiple of the step inside that range, so `base_i + offset_a` can
   * never equal `base_j + offset_b`. A step of 20 would break it — 5433 - 5173
   * is 260 — and the breakage would look exactly like the bug this fixes.
   */
  test('no two (base, offset) pairs collide across the whole offset range', () => {
    const seen = new Map<number, string>();
    for (let slot = 0; slot <= OFFSET_SLOTS; slot++) {
      const offset = slot * OFFSET_STEP;
      for (const service of STACK_SERVICES) {
        const port = service.base + offset;
        const previous = seen.get(port);
        expect(previous ?? `${service.env}+${offset}`).toBe(`${service.env}+${offset}`);
        seen.set(port, `${service.env}+${offset}`);
      }
    }
  });

  test('the primary checkout keeps the documented ports', () => {
    // `localhost:5173` is in CLAUDE.md, in the e2e defaults and in muscle
    // memory. Moving it everywhere would trade one worktree's problem for
    // everybody's.
    const ports = stackPorts('/fixture/checkouts/primary/scani', true);
    for (const service of STACK_SERVICES) expect(ports[service.env]).toBe(service.base);
  });

  test('a linked worktree is offset off the defaults, deterministically', () => {
    const worktree = '/fixture/worktrees/env_fixture01/scani';
    const offset = portOffset(worktree, false);
    expect(offset).toBeGreaterThanOrEqual(OFFSET_STEP);
    expect(offset).toBeLessThanOrEqual(OFFSET_SLOTS * OFFSET_STEP);
    expect(offset % OFFSET_STEP).toBe(0);
    expect(portOffset(worktree, false)).toBe(offset);
    expect(stackPorts(worktree, false).FRONTEND_HOST_PORT).toBe(5173 + offset);
  });

  test('every port stays inside the range a host will publish', () => {
    const { digest } = worktreeIdentity('/anything/env_x/scani');
    expect(digest).toMatch(/^[0-9a-f]{8}$/);
    for (const service of STACK_SERVICES) {
      expect(service.base + OFFSET_SLOTS * OFFSET_STEP).toBeLessThan(65535);
      expect(service.base).toBeGreaterThan(1023);
    }
  });
});

describe('the port list is the one docker-compose.yml actually reads', () => {
  const compose = readFileSync(new URL('../../docker-compose.yml', import.meta.url), 'utf8');

  test('every override in the compose file is derived by the stack script', () => {
    // Otherwise a service added there takes a fixed host port again, and the
    // second worktree to start meets it as a bind failure — or worse, silently
    // publishes onto a port another stack expects to own.
    //
    // ONE DIRECTION ONLY, and deliberately (SC-497). This file is shared
    // between two repositories, and `STACK_SERVICES` is the union of what
    // either one's compose file may publish — so the reverse direction, that
    // every derived port is read here, is false in a tree with fewer services
    // and perfectly correct there. It is asserted in each repo alongside its
    // own compose file. This direction is the one that catches the defect a
    // shared file can catch: a service added with a fixed host port.
    const referenced = new Set(
      [...compose.matchAll(/\$\{([A-Z_]+_HOST_PORT)/g)].map((m) => m[1] as string)
    );
    const derived = new Set(STACK_SERVICES.map((s) => s.env));
    expect([...referenced].filter((v) => !derived.has(v)).sort()).toEqual([]);
  });

  test('the stack offers exactly the services this compose file publishes', () => {
    // The round trip on SC-497's derivation. `publishedServices` is what
    // `reachableAt` prints and what `explainPortConflicts` interrogates, and
    // getting it wrong is silent in both directions: too many and somebody is
    // sent to a URL nothing answers, too few and a stack the script really did
    // start goes unmentioned.
    //
    // Computed here from the file rather than from the function under test, so
    // this is a comparison and not a restatement.
    //
    // THE TWO DIRECTIONS HAVE TEETH IN DIFFERENT TREES, and that is worth
    // knowing before anyone simplifies this to one loop (SC-497). Measured by
    // breaking the derivation on purpose: dropping a published service fails
    // in a tree whose compose reads every variable, while returning the whole
    // of `STACK_SERVICES` passes there — it can only fail where the compose
    // file publishes a subset. Neither loop is redundant; each is the live one
    // somewhere.
    const shown = publishedServices().map((s) => s.env);
    for (const env of shown) expect(compose).toContain(`\${${env}`);
    for (const service of STACK_SERVICES) {
      if (compose.includes(`\${${service.env}`)) expect(shown).toContain(service.env);
    }
  });

  test('the database is named only where this compose file reads it', () => {
    // The other half of the same derivation, and the one with a wrong answer
    // that reads as authoritative: a banner naming `scani_dev_<suffix>` where
    // nothing creates it sends somebody looking for a database by name.
    expect(composeInterpolates().has('SCANI_DEV_DB')).toBe(compose.includes('${SCANI_DEV_DB'));
  });

  test('the compose file names no container of its own', () => {
    // A fixed `container_name:` is what let a second worktree's `up` adopt and
    // recreate the first's containers whatever the project name said.
    expect(compose).not.toContain('container_name:');
  });

  test('the default published port matches the documented one', () => {
    // Only the services THIS compose file publishes, for the same reason the
    // assertion above runs one way (SC-497). Sweeping all of `STACK_SERVICES`
    // is each repo's own business, next to the compose file where every entry
    // has a service behind it.
    for (const service of publishedServices()) {
      expect(compose).toContain(`\${${service.env}:-${service.base}}`);
    }
  });
});

/**
 * SC-500. `portOffset`'s own comment said two worktrees drawing the same slot
 * "collides loudly on a port bind, and the override below is the answer".
 * There was no override. `stackEnv` spread the derived ports unconditionally
 * and `run()` built `{ ...process.env, ...env }`, so `POSTGRES_HOST_PORT=…
 * bun run dev:stack` was discarded without a word.
 *
 * The override RULE itself is pinned in `scripts/tests/worktree-ports.test.ts`,
 * which imports only `scripts/lib/worktree.ts` and therefore travels to the
 * mirror — where nothing else exercises it, because no CI run ever sets a
 * `<SERVICE>_HOST_PORT`. What is left here is the other half: that
 * `dev-stack` hands the override on to compose, and that no consumer of these
 * ports derives one without it.
 */
describe('dev:stack passes the override through to compose', () => {
  /**
   * THIS FIXTURE IS THE CHECKOUT THE TEST IS RUNNING IN, and it is the one
   * place in this file that may not be a hardcoded path (SC-563).
   *
   * The three fixtures above are literals on purpose and stay literals: they
   * feed `composeProjectName`, `worktreeIdentity` and `stackPorts(path,
   * <explicit flag>)`, which are pure string functions and never look at the
   * filesystem. A path that does not exist is a perfectly good input to them,
   * and since SC-566 they are deliberately paths that never will.
   *
   * `stackEnv` is different — it derives primary-ness itself, by running `git
   * rev-parse` with the path as `cwd`. So a literal here is a claim that some
   * directory exists on the machine running the suite. This one used to name
   * a specific bb worktree; that worktree was reaped, `spawnSync` failed,
   * `isPrimaryCheckout` reported *primary*, and
   * `bun run test` went red on main for everyone with `Expected "5673"
   * Received "5173"` — a message about a PORT, which reads as a derivation
   * regression and is nothing of the kind.
   *
   * Do not repoint it at whichever worktree happens to exist today. SC-530 is
   * about reaping exactly these, so the next reap would reproduce this bug and
   * it would look like a port regression a second time.
   */
  const WORKTREE = resolve(import.meta.dir, '..', '..');

  test('stackEnv publishes on the port the environment asked for', () => {
    // The half the ticket was filed for: `dev:stack` binding a port the
    // operator explicitly moved it to, rather than the derived one.
    expect(stackEnv(WORKTREE, { POSTGRES_HOST_PORT: '7233' }).POSTGRES_HOST_PORT).toBe('7233');
  });

  test('nothing set leaves every published port exactly as derived', () => {
    // `isPrimaryCheckout` rather than a hardcoded `false`, because the answer
    // depends on where the suite is running: this repo is worked in both the
    // primary checkout and in linked bb worktrees, and the previous literal
    // asserted the linked answer unconditionally.
    //
    // NOT VACUOUS, though it now mirrors `stackEnv`'s own derivation. The
    // subject is the OVERRIDE, not the derivation: with an empty env, this
    // fails the moment `stackPortOverrides` reads `process.env` instead of the
    // map it was handed — which is SC-500's defect with the sign flipped, and
    // this suite is routinely run with `POSTGRES_HOST_PORT` already set in the
    // environment. The derivation itself is pinned by
    // `worktree-ports.test.ts` and by the offset tests above, both of which
    // pass the flag explicitly and touch no disk.
    const primary = isPrimaryCheckout(WORKTREE);
    const env = stackEnv(WORKTREE, {});
    for (const service of STACK_SERVICES) {
      expect(env[service.env]).toBe(String(stackPorts(WORKTREE, primary)[service.env]));
    }
  });

  test('the fixture names a directory that exists', () => {
    // The assertion the whole ticket is about. Every test in this block calls
    // `stackEnv`, which shells out with `WORKTREE` as `cwd` — so if this path
    // is not real, they do not fail, they quietly measure the wrong checkout.
    // This one says so in a sentence instead.
    expect(`${WORKTREE} exists: ${existsSync(WORKTREE)}`).toBe(`${WORKTREE} exists: true`);
    expect(existsSync(join(WORKTREE, 'package.json'))).toBe(true);
  });

  test('the project name and the database are not affected by a port override', () => {
    // The isolator is the project name (SC-491); moving a port must not move
    // the identity a person reads `docker ps` and `\l` against.
    expect(stackEnv(WORKTREE, { POSTGRES_HOST_PORT: '7233' }).COMPOSE_PROJECT_NAME).toBe(
      stackEnv(WORKTREE, {}).COMPOSE_PROJECT_NAME
    );
    expect(stackEnv(WORKTREE, { POSTGRES_HOST_PORT: '7233' }).SCANI_DEV_DB).toBe(
      stackEnv(WORKTREE, {}).SCANI_DEV_DB
    );
  });
});

describe('every consumer of the published ports reads the same override', () => {
  // Only the consumers this file can be sure of in either repository (SC-497).
  // A repo with further consumers of these ports asserts them the same way,
  // beside its own copy of them.
  const sources = [
    '../dev-stack.ts',
    '../../apps/e2e/scripts/run.ts',
    '../../apps/e2e/scripts/visual.ts',
  ];

  /**
   * An override that moved the containers and left the gate behind would be
   * worse than no override at all — the stack relocates and the gate keeps
   * connecting to whatever took the old port, which is the silent failure this
   * ticket is about, now reachable on purpose.
   */
  test('no consumer derives a port without honouring the environment', () => {
    for (const source of sources) {
      const text = readFileSync(new URL(source, import.meta.url).pathname, 'utf8');
      expect(`${source}: ${text.includes('stackPorts(')}`).toBe(`${source}: false`);
      expect(`${source}: ${text.includes('resolveStackPorts(')}`).toBe(`${source}: true`);
    }
  });
});

describe('`down` finishes, and says so only when it can prove it (SC-663)', () => {
  /**
   * Compose stops containers whose service is in the compose file it is
   * reading NOW. The project name comes from the worktree PATH (SC-491), the
   * service SET from the BRANCH, and the two files disagree — measured
   * 2026-08-26 with `docker compose --profile full config --services`:
   *
   *   private only:  admin  backend  cloud-frontend  landing
   *   upstream only: api
   *
   * So switching branches between `up` and `down` orphans one container going
   * upstream -> private, and FOUR going private -> upstream. Compose skips
   * every one and reports success.
   */
  test('the flag that makes `down` mean what its name says is present', () => {
    expect(downArgs()).toContain('--remove-orphans');
  });

  test('a passthrough argument survives it', () => {
    // `dev:stack:down -- --volumes` is documented in three places.
    expect(downArgs(['--volumes'])).toEqual([
      'docker',
      'compose',
      '--profile',
      'full',
      'down',
      '--remove-orphans',
      '--volumes',
    ]);
  });

  test('a clean teardown names the count it verified, not just success', () => {
    const { message, exit } = downVerdict(0, [], 'scani_env_x');
    expect(exit).toBe(0);
    // The count is IN the verdict line, so reading the verdict is reading the
    // evidence — the same reason gate-db prints the database it reached.
    expect(message).toContain('0 containers remain in scani_env_x');
  });

  test('a container left behind is a failure, and is named', () => {
    const { message, exit } = downVerdict(0, ['scani_env_x-api-1'], 'scani_env_x');
    expect(exit).not.toBe(0);
    expect(message).toContain('DOWN INCOMPLETE');
    expect(message).toContain('scani_env_x-api-1');
  });

  test('all four orphans of a private -> upstream switch are counted', () => {
    const left = ['x-admin-1', 'x-backend-1', 'x-cloud-frontend-1', 'x-landing-1'];
    const { message, exit } = downVerdict(0, left, 'scani_env_x');
    expect(exit).not.toBe(0);
    expect(message).toContain('4 container(s)');
    for (const name of left) expect(message).toContain(name);
  });

  test('not being able to ask docker is never resolved toward zero', () => {
    // `null` is "could not ask", and the whole defect was a teardown claiming
    // success over containers it never looked at. Absence of evidence.
    const { message, exit } = downVerdict(0, null, 'scani_env_x');
    expect(exit).not.toBe(0);
    expect(message).toContain('UNVERIFIED');
    expect(message).not.toContain('0 containers remain');
  });

  test('the verdict line cannot contradict its own exit code', () => {
    // The first version printed COMPOSE's code in the message, so a real run
    // read `DOWN INCOMPLETE · exit 0 · 1 container(s) still in ...` on a
    // command that exits 1. The tests asserted the exit and the text
    // separately and never that they agree, so only running it caught it.
    for (const [code, remaining] of [
      [0, []],
      [0, ['x-admin-1']],
      [0, null],
      [17, []],
      [17, ['x-admin-1']],
      [17, null],
    ] as ReadonlyArray<[number, string[] | null]>) {
      const { message, exit } = downVerdict(code, remaining, 'scani_env_x');
      expect(`${code}/${remaining === null ? 'null' : remaining.length}: ${message}`).toContain(
        `exit ${exit}`
      );
    }
  });

  test("compose's own exit is still shown when it differs from ours", () => {
    // Two different problems: compose failing, and a teardown that did not
    // finish. Collapsing them into one number loses which one happened.
    expect(downVerdict(17, ['x-admin-1'], 'p').message).toContain('compose exit 17');
    expect(downVerdict(0, ['x-admin-1'], 'p').message).not.toContain('compose exit');
  });

  test("compose's own failure is propagated, not replaced by ours", () => {
    expect(downVerdict(17, [], 'scani_env_x').exit).toBe(17);
    expect(downVerdict(17, null, 'scani_env_x').exit).toBe(17);
    expect(downVerdict(17, ['x-api-1'], 'scani_env_x').exit).toBe(17);
  });
});

describe('up waits for the healthchecks that are already declared (SC-669)', () => {
  const H = (name: string, state: 'healthy' | 'unhealthy' | 'starting' | 'none') => ({
    name,
    state,
  });

  test('the up argv carries --wait', () => {
    // `up -d` returns once containers have STARTED. Pinned here because the
    // flag's absence is invisible in a green run — which is how it survived
    // alongside healthchecks that were already declared.
    expect(upArgs()).toContain('--wait');
  });

  test('passthrough is preserved and --wait still present', () => {
    expect(upArgs(['postgres', 'redis'])).toEqual([
      'docker',
      'compose',
      '--profile',
      'full',
      'up',
      '-d',
      '--build',
      '--wait',
      'postgres',
      'redis',
    ]);
  });

  test('a stack where everything is healthy reports what it VERIFIED', () => {
    const { message, exit } = upVerdict(
      0,
      [H('p-postgres-1', 'healthy'), H('p-redis-1', 'healthy'), H('p-admin-1', 'none')],
      'scani_env_x'
    );
    expect(exit).toBe(0);
    // `3 running` alone invites the reader to assume all three were checked.
    expect(message).toContain('3 running, 2 health-verified');
  });

  test('an unhealthy service refuses and names it', () => {
    const { message, exit } = upVerdict(
      0,
      [H('p-postgres-1', 'healthy'), H('p-backend-1', 'unhealthy')],
      'scani_env_x'
    );
    expect(exit).not.toBe(0);
    expect(message).toContain('UP UNHEALTHY');
    expect(message).toContain('p-backend-1 (unhealthy)');
  });

  test('a service still starting is not verified either', () => {
    // `--wait` should have blocked, so reaching this is an anomaly. Counting
    // it as fine is the "could not tell resolved toward fine" move that
    // `downVerdict` exists to refuse.
    const { exit } = upVerdict(0, [H('p-backend-1', 'starting')], 'scani_env_x');
    expect(exit).not.toBe(0);
  });

  test('docker being unaskable is NOT a clean start', () => {
    const { message, exit } = upVerdict(0, null, 'scani_env_x');
    expect(exit).toBe(1);
    expect(message).toContain('UP UNVERIFIED');
    expect(message).not.toContain('UP · exit 0');
  });

  test('a service with no healthcheck is not counted as a failure', () => {
    // Nine services here declare none. Treating "no healthcheck" as unhealthy
    // would refuse every healthy stack.
    const { exit } = upVerdict(0, [H('p-admin-1', 'none'), H('p-worker-1', 'none')], 'scani_env_x');
    expect(exit).toBe(0);
  });

  test('the verdict line cannot contradict its own exit code', () => {
    // Same lesson as `downVerdict`: asserting the exit and the text separately
    // never catches a message that names the other number.
    for (const [code, health] of [
      [0, []],
      [0, [H('x-postgres-1', 'healthy')]],
      [0, [H('x-backend-1', 'unhealthy')]],
      [0, null],
      [17, []],
      [17, [H('x-backend-1', 'unhealthy')]],
      [17, null],
    ] as ReadonlyArray<[number, ReturnType<typeof H>[] | null]>) {
      const { message, exit } = upVerdict(code, health, 'scani_env_x');
      expect(`${code}/${health === null ? 'null' : health.length}: ${message}`).toContain(
        `exit ${exit}`
      );
    }
  });

  test("compose's own code is shown when it differs, and not when it does not", () => {
    expect(upVerdict(17, [H('x-backend-1', 'unhealthy')], 'p').message).toContain(
      'compose exit 17'
    );
    expect(upVerdict(0, [H('x-backend-1', 'unhealthy')], 'p').message).not.toContain(
      'compose exit'
    );
  });

  test("a compose failure keeps compose's exit code", () => {
    expect(upVerdict(17, [], 'scani_env_x').exit).toBe(17);
    expect(upVerdict(17, null, 'scani_env_x').exit).toBe(17);
  });
});

describe('--infra-only starts what a gate uses and nothing else (SC-706)', () => {
  const H = (name: string, state: 'healthy' | 'unhealthy' | 'starting' | 'none') => ({
    name,
    state,
  });

  test('the infra argv omits --profile full, which IS the whole mechanism', () => {
    // Every service a gate does not need declares `profiles: ["full"]`; the
    // four it does need declare no profile at all. So the infra set is the
    // compose file's own default rather than a list kept beside it.
    expect(upArgs([], 'infra')).not.toContain('full');
    expect(upArgs([], 'full')).toContain('full');
  });

  test('infra still waits for healthchecks', () => {
    // The flag whose absence is invisible in a green run (SC-669). A new mode
    // is exactly where it would get dropped.
    expect(upArgs([], 'infra')).toContain('--wait');
  });

  test('the default mode is unchanged, so no caller starts less than before', () => {
    expect(upArgs(['postgres'])).toEqual(upArgs(['postgres'], 'full'));
  });

  test('--infra-only is consumed, never handed to compose', () => {
    // `docker compose up` rejects an unknown flag, so forwarding it would turn
    // the feature into a usage error rather than a smaller stack.
    const { mode, rest } = parseMode(['--infra-only', '--pull', 'always']);
    expect(mode).toBe('infra');
    expect(rest).toEqual(['--pull', 'always']);
    expect(upArgs(rest, mode)).not.toContain('--infra-only');
  });

  test('without the flag the mode is full and argv is untouched', () => {
    const { mode, rest } = parseMode(['postgres']);
    expect(mode).toBe('full');
    expect(rest).toEqual(['postgres']);
  });

  test('the derivation FINDS the infra services — an empty set would be silent', () => {
    // The must-be-FOUND control. A broken parse returns an empty set, which
    // makes `publishedServices('infra')` empty, which makes `up` print no
    // reachable services at all — tidy, wrong, and indistinguishable from a
    // stack with nothing published.
    const infra = defaultProfileInterpolations();
    expect(infra.has('POSTGRES_HOST_PORT')).toBe(true);
    expect(infra.has('REDIS_HOST_PORT')).toBe(true);
    expect(publishedServices('infra').length).toBeGreaterThan(0);
  });

  test('the derivation EXCLUDES services behind the full profile', () => {
    // The must-be-ABSENT half. `publishedServices` feeds the "reachable at"
    // list, so a service named here is a claim that something is listening on
    // that port — false for anything infra-only did not start.
    const infra = defaultProfileInterpolations();
    const full = composeInterpolates();
    const behindFull = [...full].filter((v) => v.endsWith('HOST_PORT') && !infra.has(v));
    // Both trees have at least one app service published; which ones differ
    // (upstream has `api`, the private tree has `backend` and three more
    // frontends), so this asserts the SHAPE rather than a service list.
    expect(behindFull.length).toBeGreaterThan(0);
    for (const v of behindFull) expect(infra.has(v)).toBe(false);
  });

  test('infra is a strict subset of full', () => {
    const infra = publishedServices('infra').map((s) => s.label);
    const full = publishedServices('full').map((s) => s.label);
    expect(infra.length).toBeLessThan(full.length);
    for (const label of infra) expect(full).toContain(label);
  });

  test('infra names only services meant to STAY UP — a one-shot fails --wait', () => {
    // The bug this caught, measured before the fix:
    //   container ..-minio-init-1 exited (0)
    //   dev-stack: UP · exit 1 · 4 running, 4 health-verified · infra-only
    // exit 1 over a completely healthy stack. `--wait` supervises whatever it
    // is asked to start and a one-shot exiting 0 is a FAILURE to it. It never
    // shows in `full` mode because there the one-shots arrive as dependencies
    // under `condition: service_completed_successfully`, which `--wait`
    // understands — naming them directly opts out of that, exactly as naming a
    // service opts out of its healthcheck (SC-669).
    const longRunning = defaultProfileLongRunning();
    expect(longRunning.length).toBeGreaterThan(0);
    for (const name of longRunning) expect(upArgs([], 'infra')).toContain(name);
  });

  test('the one-shots are excluded from the infra argv', () => {
    // must-be-ABSENT. `restart: "no"` is the compose file's own marker for
    // "this exits", so the split is derived rather than listed — and these are
    // the three names that turned a green stack into exit 1.
    const argv = upArgs([], 'infra');
    for (const oneShot of ['minio-init', 'env-sync', 'deps']) {
      expect(argv).not.toContain(oneShot);
    }
  });

  test('full mode names no services at all, so dependencies still govern it', () => {
    // The `full` path must keep relying on compose's own dependency graph:
    // naming services there would opt every one of them out of the
    // `service_completed_successfully` conditions the app services declare.
    const argv = upArgs([], 'full');
    for (const name of defaultProfileLongRunning()) expect(argv).not.toContain(name);
  });

  test('the verdict says which half it brought up, on BOTH modes', () => {
    // `7 running` under infra-only is a healthy stack and is identical to what
    // a broken `full` stack prints. Naming `full` when it is full is what stops
    // the word's ABSENCE being read as a claim (SC-500's lesson).
    expect(upVerdict(0, [H('p-postgres-1', 'healthy')], 'proj', 'infra').message).toContain(
      'infra-only'
    );
    expect(upVerdict(0, [H('p-postgres-1', 'healthy')], 'proj', 'full').message).toContain('full');
  });

  test('a refusal names the mode too', () => {
    // A stack that could not be verified is the case a reader most needs the
    // provenance for, so the clause must not be success-only.
    expect(upVerdict(0, null, 'proj', 'infra').message).toContain('infra-only');
  });
});
