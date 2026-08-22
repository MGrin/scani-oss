import { describe, expect, test } from 'bun:test';
import {
  describeHolder,
  foreignHolder,
  type PortHolder,
  parsePortHolders,
} from '../lib/port-holder';

/**
 * SC-500. `portOffset` hands a linked worktree one of twenty slots, so two
 * worktrees can derive the same `POSTGRES_HOST_PORT`. `docker compose up` meets
 * that as a bind failure; everything that CONNECTS meets it silently. This file
 * covers the part that decides whether the answer on a port is somebody else's.
 *
 * The fixture has the shape of real `docker ps` output captured on
 * 2026-08-22, when one bb worktree's derived Postgres port was being published
 * by a worktree that had since been deleted. The paths and the container names
 * are synthetic (SC-566) — `parsePortHolders` reads them as strings and never
 * stats them — but they are kept CONSISTENT with each other: the project name
 * and the published port below are what `composeProjectName` and `stackPorts`
 * actually derive for that path, so a reader cannot be misled about how the
 * three relate.
 */
const DOCKER_PS = [
  [
    'scani_env_fixture02_96c4c292-postgres-1',
    'scani_env_fixture02_96c4c292',
    '/fixture/worktrees/env_fixture02/scani',
    '0.0.0.0:6133->5432/tcp, [::]:6133->5432/tcp',
  ].join('\t'),
  [
    'scani-postgres-1',
    'scani',
    '/fixture/checkouts/primary/scani',
    '0.0.0.0:5433->5432/tcp, [::]:5433->5432/tcp',
  ].join('\t'),
  ['ab-testneo4j', '', '', '7473-7474/tcp, 0.0.0.0:5595->7687/tcp, [::]:5595->7687/tcp'].join('\t'),
  ['buildx_buildkit_scani-publish0', '', '', ''].join('\t'),
].join('\n');

describe('parsePortHolders reads the PUBLISHED port, not the container port', () => {
  test('finds the container publishing a host port', () => {
    const holders = parsePortHolders(DOCKER_PS, 6133);
    expect(holders).toHaveLength(1);
    expect(holders[0]?.container).toBe('scani_env_fixture02_96c4c292-postgres-1');
    expect(holders[0]?.workingDir).toBe('/fixture/worktrees/env_fixture02/scani');
  });

  test('a container port is not a host port', () => {
    // `0.0.0.0:5933->5432/tcp` publishes 5933 and exposes 5432. Matching
    // anywhere in the string would make every compose Postgres on this machine
    // read as the holder of host 5432 — a refusal nobody could act on, on a
    // port nobody bound.
    expect(parsePortHolders(DOCKER_PS, 5432)).toEqual([]);
    expect(parsePortHolders(DOCKER_PS, 7687)).toEqual([]);
  });

  test('a port with no host mapping at all is nobody', () => {
    // `7473-7474/tcp` is exposed and unpublished; a substring match would
    // claim it.
    expect(parsePortHolders(DOCKER_PS, 7473)).toEqual([]);
  });

  test('a longer port number that CONTAINS the one asked for does not match', () => {
    const line = ['x', 'p', '/w', '0.0.0.0:15933->5432/tcp'].join('\t');
    expect(parsePortHolders(line, 5933)).toEqual([]);
    expect(parsePortHolders(line, 15933)).toHaveLength(1);
  });

  test('a container with no ports and no labels parses without throwing', () => {
    expect(parsePortHolders(DOCKER_PS, 1)).toEqual([]);
  });
});

describe('foreignHolder judges on the compose working_dir, never the project name', () => {
  const PRIMARY = '/fixture/checkouts/primary/scani';

  test('another checkout is foreign', () => {
    const holders = parsePortHolders(DOCKER_PS, 6133);
    expect(foreignHolder(holders, PRIMARY)?.container).toBe(
      'scani_env_fixture02_96c4c292-postgres-1'
    );
  });

  /**
   * THE TEST THAT PROVES THE NEW STATE DOES NOT ALWAYS FIRE, and the one worth
   * keeping longest. A state that only ever fires is indistinguishable from a
   * broken one.
   *
   * It is also why the key is `working_dir`. This container's compose PROJECT
   * is `scani` — the directory leaf, which is what a bare `docker compose up`
   * picks — not the derived `scani_mgrin_<digest>`. Comparing project names
   * would refuse on the primary checkout, which is legitimate every time and
   * has never had this bug. A guard that fires on the legitimate case is a
   * guard somebody disables.
   */
  test('the primary checkout is NOT foreign, though its project name differs', () => {
    const holders = parsePortHolders(DOCKER_PS, 5433);
    expect(holders[0]?.project).toBe('scani');
    expect(foreignHolder(holders, PRIMARY)).toBeNull();
  });

  test('a trailing slash on either side is the same directory', () => {
    const holders = parsePortHolders(DOCKER_PS, 5433);
    expect(foreignHolder(holders, `${PRIMARY}/`)).toBeNull();
  });

  /**
   * A reader will want to make this refuse. It must not.
   *
   * A container with no compose labels is a `docker run` somebody did by hand,
   * or a Postgres that is not a container at all. That is UNKNOWN, and unknown
   * is not evidence of foreignness. Reading it as foreign would refuse gates
   * for people whose setup has never been wrong, and the caller already
   * prints the unknown rather than swallowing it.
   */
  test('a container with no compose labels is unknown, not foreign', () => {
    const holders = parsePortHolders(DOCKER_PS, 5595);
    expect(holders).toHaveLength(1);
    expect(holders[0]?.workingDir).toBe('');
    expect(foreignHolder(holders, PRIMARY)).toBeNull();
  });

  test('nothing on the port is not foreign either', () => {
    expect(foreignHolder([], PRIMARY)).toBeNull();
  });
});

describe('describeHolder says whether the holder still has a worktree', () => {
  test('names an orphan as an orphan', () => {
    const holder: PortHolder = {
      container: 'scani_env_fixture02_96c4c292-postgres-1',
      project: 'scani_env_fixture02_96c4c292',
      workingDir: '/fixture/worktrees/env_fixture02/does-not-exist',
    };
    const sentence = describeHolder(holder, 6133);
    expect(sentence).toContain('port 6133 is held by');
    expect(sentence).toContain('no longer exists');
  });

  /**
   * IT REPORTS THE EVIDENCE, NEVER THE CONCLUSION, and a reader will want to
   * shorten it to "orphaned" — which is the sentence that gets a live
   * container stopped.
   *
   * Found by SC-498's thread while reaping ownerless stacks: the compose
   * project literally named `scani` carries a DELETED worktree's `working_dir`
   * on its postgres and redis containers, which publish 5433 and 6380 — the
   * documented default ports, serving the PRIMARY
   * checkout. A worktree that ran a bare `docker compose up` adopted the
   * default project name (the directory leaf, `scani` everywhere) and stamped
   * its own path onto containers it did not own.
   *
   * So a missing directory is NECESSARY and NOT SUFFICIENT for "nobody needs
   * this"; the project name has to be one no live checkout produces too.
   */
  test('a missing directory is reported as a missing directory, not as an orphan', () => {
    const adopted: PortHolder = {
      container: 'scani-postgres-1',
      project: 'scani',
      workingDir: '/fixture/worktrees/env_deleted/scani',
    };
    const sentence = describeHolder(adopted, 5433);
    expect(sentence).toContain('no longer exists');
    expect(sentence.toLowerCase()).not.toContain('orphan');
    expect(sentence.toLowerCase()).not.toContain('safe to');
  });

  test('a directory that exists is not called gone', () => {
    const holder: PortHolder = {
      container: 'c',
      project: 'p',
      workingDir: new URL('../..', import.meta.url).pathname,
    };
    expect(describeHolder(holder, 6133)).not.toContain('no longer exists');
  });

  test('a holder with no labels still produces a readable sentence', () => {
    const sentence = describeHolder({ container: 'ab-testpg', project: '', workingDir: '' }, 5601);
    expect(sentence).toContain('ab-testpg');
    expect(sentence).toContain('not a compose container');
  });
});
