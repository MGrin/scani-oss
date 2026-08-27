import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { composeProjectName, e2eProjectName } from '../lib/worktree';

/**
 * SC-493. `apps/e2e/scripts/run.ts` drove compose with no project name and
 * tore its stack down with `down -v`. Compose names an unnamed project after
 * the directory leaf — `scani` in every bb worktree and in the primary
 * checkout — so the teardown was aimed at whatever stack was already running,
 * and `-v` removes volumes. SC-491 was the same defect one step milder: there
 * the second `up` adopted and *recreated* somebody's Postgres, here it deletes
 * the database.
 *
 * The file is read as text on purpose. The property worth protecting is not
 * "the current call sites are right" — it is that a compose call with no
 * project can never be added back, and only the source says that.
 */
const RUNNER = new URL('../../apps/e2e/scripts/run.ts', import.meta.url);
const SOURCE = readFileSync(RUNNER, 'utf8');

/** Lines that hand `'compose'` to docker as an argument, not ones that mention it in prose. */
const COMPOSE_ARGV_LINES = SOURCE.split('\n').filter((line) => /'compose'/.test(line));

describe('the e2e runner can only ever compose against its own project', () => {
  test('every docker compose argv names --project-name', () => {
    expect(COMPOSE_ARGV_LINES.length).toBeGreaterThan(0);
    for (const line of COMPOSE_ARGV_LINES) {
      expect(line).toContain("'--project-name'");
    }
  });

  test('there is exactly one path to compose', () => {
    // Two would mean one of them can drift. The guard above only holds
    // because every call goes through the single `composeArgv()` builder.
    expect(COMPOSE_ARGV_LINES).toHaveLength(1);
  });

  test('every docker spawn is built by that one builder', () => {
    // SC-496 added a second spawn — the `config --services` probe that asks
    // this repo's compose what it calls the api service. It captures stdout,
    // so it cannot reuse `run()`, and a hand-assembled argv next to it would
    // be exactly the unnamed project the test above exists to forbid.
    const dockerSpawns = SOURCE.split('\n').filter((line) => /['"]docker['"]/.test(line));
    expect(dockerSpawns.length).toBeGreaterThan(0);
    for (const line of dockerSpawns) {
      // SC-494 added the second exception, `dockerQuery`. It is NOT a compose
      // call: `ps` and `inspect` are read-only and take no project, and they
      // are how the runner discovers WHICH project a stack it did not create
      // belongs to. Routing them through `composeArgv` would be meaningless.
      // What the guard still forbids is a hand-assembled docker argv at a call
      // site, so there is exactly one such helper and it is named here.
      expect(line).toMatch(/composeArgv\(|spawnSync\('docker', \[verb/);
    }
  });

  test('the non-compose escape hatch is read-only, and only these two verbs', () => {
    // Widening the rule above is safe only while the exception cannot mutate
    // anything. `dockerQuery` takes its verb as a separate parameter precisely
    // so this can be read without depending on how the argv array is
    // formatted — a check that breaks when biome rewraps a line is a check
    // that gets deleted.
    const verbs = [...SOURCE.matchAll(/dockerQuery\('([a-z]+)'/g)]
      .map((m) => m[1])
      .filter((v): v is string => v !== undefined);
    expect(verbs.length).toBeGreaterThan(0);
    for (const verb of verbs) {
      expect(['ps', 'inspect']).toContain(verb);
    }
  });

  test('`down -v` is reachable only through that path', () => {
    // `-v` deletes volumes. Anywhere else in this file it would be a `docker`
    // invocation this test cannot see the project of.
    const volumeFlags = SOURCE.split('\n').filter((line) => /'(-v|--volumes)'/.test(line));
    for (const line of volumeFlags) {
      expect(line).toMatch(/compose\(\[/);
    }
  });
});

describe('the e2e stack is not the stack somebody is developing against', () => {
  /**
   * Synthetic on purpose (SC-566). `composeProjectName` and `e2eProjectName`
   * hash the path string and never touch disk, so naming a real checkout here
   * published one machine's directory layout to the public mirror and bought
   * no coverage for it. The shape is what matters — a leaf of `scani` under a
   * meaningful parent, which is what `worktreeIdentity` reads.
   */
  const WORKTREE = '/fixture/worktrees/env_fixture01/scani';
  const PRIMARY = '/fixture/checkouts/primary/scani';

  test('its project differs from the dev stack of the same checkout', () => {
    // Same project would put `down -v` on the dev volumes the moment the
    // runner took Mode B — which it does whenever the dev stack is up but
    // not yet healthy.
    expect(e2eProjectName(WORKTREE)).not.toBe(composeProjectName(WORKTREE));
  });

  test('two checkouts still get different e2e projects', () => {
    expect(e2eProjectName(WORKTREE)).not.toBe(e2eProjectName(PRIMARY));
  });

  test('the name is legal for compose', () => {
    for (const path of [WORKTREE, PRIMARY, '/tmp/Weird Name (2)/scani']) {
      expect(e2eProjectName(path)).toMatch(/^[a-z0-9][a-z0-9_-]*$/);
    }
  });
});
