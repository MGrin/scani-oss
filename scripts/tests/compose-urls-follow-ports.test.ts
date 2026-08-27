import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { STACK_SERVICES } from '../lib/worktree';

/**
 * SC-495. `docker-compose.yml` publishes every host port through a
 * `*_HOST_PORT` variable, and then told the browser where to find those
 * services with the default port written out by hand:
 *
 *     ports:        - "${API_HOST_PORT:-3011}:3001"
 *     environment:  BACKEND_URL: http://localhost:3011
 *
 * Move the port and the URL stays behind. On a linked worktree — where
 * `scripts/lib/worktree.ts` offsets every port so two checkouts can run a
 * stack at once — the api published on 3711 and minted magic links pointing
 * at 3011, so `tests/auth/magic-link-sign-in.spec.ts` failed on all four
 * Playwright projects with `ERR_CONNECTION_REFUSED`, deterministically.
 *
 * CI never sees it: it takes the defaults, where the hand-written value
 * happens to be right. So the property has to be asserted from the file
 * itself rather than from a run.
 *
 * The four instances that existed — the api's FRONTEND_URL / BACKEND_URL and
 * the data-provider's BETTER_AUTH_URL / CLOUD_FRONTEND_ORIGIN — were fixed in
 * #120, and this passes against that tree unchanged. It is here for the next
 * one: nothing else in either repo fails on a literal port beside a variable
 * one, which is how these four survived to be found from a worktree.
 *
 * The downstream private repo keeps a `docker-compose.yml` of its own — the
 * file is `merge=ours`-pinned, so the two deliberately diverge — and this
 * guard travels with the test rather than with either copy: it asserts
 * against whichever compose file sits beside it.
 *
 * The file is read as TEXT on purpose. `docker compose config` would resolve
 * the interpolation and hand back a literal — the very thing being forbidden.
 * What is worth protecting is that the port and the URL cannot drift apart,
 * and only the unresolved source says that.
 */
const COMPOSE = new URL('../../docker-compose.yml', import.meta.url);
const SOURCE = readFileSync(COMPOSE, 'utf8');

/** The documented default for each published port, keyed by its variable. */
const BASE_PORT = new Map(STACK_SERVICES.map((s) => [s.env, s.base]));

interface Reference {
  line: number;
  text: string;
  /** The whole `localhost:<something>` token. */
  token: string;
}

/**
 * Every `localhost:<port>` a container or a browser is told to connect to.
 *
 * Comment lines are dropped: the header block documents the defaults in prose
 * and would otherwise be read as a hundred violations of a rule prose cannot
 * break. Everything left is a value compose hands to a running service.
 */
function loopbackReferences(): Reference[] {
  return SOURCE.split('\n').flatMap((text, index) => {
    if (/^\s*#/.test(text)) return [];
    const value = text.split(/(?<!["'])\s+#\s/)[0]!;
    return [...value.matchAll(/localhost:(\$\{[^}]+\}|\d+)/g)].map((match) => ({
      line: index + 1,
      text: text.trim(),
      token: match[0],
    }));
  });
}

describe('a compose URL follows the port it points at (SC-495)', () => {
  const references = loopbackReferences();

  test('the file still has URLs to check', () => {
    // A refactor that moved them all out would otherwise make this file pass
    // by asserting nothing at all.
    expect(references.length).toBeGreaterThan(0);
  });

  test('no URL writes a host port as a literal', () => {
    // In-test, not the sibling above: an empty `references` satisfies this by
    // having nothing to filter, and the sibling's red does not un-print this
    // green (SC-733).
    expect(references.length).toBeGreaterThan(0);
    const literals = references
      .filter((ref) => /localhost:\d+$/.test(ref.token))
      .map((ref) => `docker-compose.yml:${ref.line}  ${ref.text}`);
    expect(literals).toEqual([]);
  });

  test('each one interpolates the variable that publishes that port', () => {
    // Zero iterations assert nothing and read as every reference passing.
    expect(references.length).toBeGreaterThan(0);
    for (const ref of references) {
      const variable = ref.token.match(/\$\{([A-Z0-9_]+):-(\d+)\}/);
      expect(variable, `${ref.line}: ${ref.text}`).not.toBeNull();
      const [, name = '', fallback = ''] = variable as RegExpMatchArray;
      // A URL built from a variable no `ports:` line reads moves nothing.
      expect(BASE_PORT.has(name), `${ref.line}: ${name} publishes no port`).toBe(true);
      // The fallback is what CI and the primary checkout actually use, so a
      // wrong one is invisible until somebody offsets — the original bug.
      expect(Number(fallback), `${ref.line}: ${name} defaults to ${fallback}`).toBe(
        BASE_PORT.get(name) as number
      );
    }
  });
});
