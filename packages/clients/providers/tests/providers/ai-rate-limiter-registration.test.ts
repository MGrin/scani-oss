import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { ProviderFactory, ProviderFactoryDeps } from '../../src/core/boot';
import { RateLimiterRegistry } from '../../src/core/rate-limiter-registry';
import { aiDeepseekFactory } from '../../src/providers/ai-deepseek';
import { aiOpenAIFactory, OpenAIProvider } from '../../src/providers/ai-openai';
import { aiPerplexityFactory } from '../../src/providers/ai-perplexity';

/**
 * SC-1090. `RateLimiterRegistry` exists for uniqueness ("two providers can't
 * accidentally share the same Redis namespace and silently consume each
 * other's budget") and discoverability ("`list()` returns every namespace the
 * app booted with"). 25 of the 28 providers registered; the three AI ones
 * built their limiter inside the shared `ChatCompletionsProvider` base and
 * registered nothing, so `list()` was short by three and the duplicate guard
 * was blind to exactly the three namespaces with the structural `ai:` doubling.
 *
 * ASSERTED BEHAVIOURALLY — the factories are RUN and the registry is READ —
 * rather than by grepping the tree for `register(`. A source scan would pass
 * on a `register()` call that boot never reaches, which is a stronger claim
 * about the text than about the app, and SC-1092 is a live example of two
 * guards reading green over a directory their scan cannot see.
 *
 * The one thing derived from the tree is the SET of AI providers (below), so a
 * fourth one cannot be added without either registering or turning this red.
 */

const PROVIDERS_DIR = 'packages/clients/providers/src/providers';
const REPO_ROOT = new URL('../../../../../', import.meta.url).pathname;

/** Env-gated e2e doubles, not third-party integrations — the set SC-1033 and
    SC-1085 skip, and `ai-stub` does not extend the shared base anyway. */
const STUBS = new Set(['ai-stub', 'chain-stub']);

/** The factories under test, by the directory each one lives in. */
const AI_FACTORIES: ReadonlyArray<readonly [string, ProviderFactory, string]> = [
  ['ai-openai', aiOpenAIFactory, 'OPENAI_API_KEY'],
  ['ai-deepseek', aiDeepseekFactory, 'DEEPSEEK_API_KEY'],
  ['ai-perplexity', aiPerplexityFactory, 'PERPLEXITY_API_KEY'],
];

function makeDeps(registry: RateLimiterRegistry, env: Record<string, string>): ProviderFactoryDeps {
  return {
    redis: null,
    env,
    rateLimiterRegistry: registry,
    reportCredentialStatus: () => {},
  };
}

/**
 * Every provider directory whose class extends the shared chat-completions
 * base, read from the tracked tree. A git failure THROWS: an unread tree and a
 * tree with no AI providers both yield an empty set, and the empty one would
 * satisfy every assertion below (SC-844's shape).
 */
function aiProviderDirs(): Set<string> {
  const ls = Bun.spawnSync(['git', 'ls-files', PROVIDERS_DIR], { cwd: REPO_ROOT });
  if (ls.exitCode !== 0) {
    throw new Error(`git ls-files ${PROVIDERS_DIR} failed: ${ls.stderr.toString().trim()}`);
  }
  const dirs = new Set<string>();
  for (const file of ls.stdout.toString().split('\n')) {
    if (!file.endsWith('.ts')) continue;
    const rest = file.slice(PROVIDERS_DIR.length + 1);
    // A file directly under `providers/` (`_chat-completions.ts` itself)
    // carries no slash, so the slash is what says "directory" — SC-1033's rule.
    if (!rest.includes('/')) continue;
    const dir = rest.slice(0, rest.indexOf('/'));
    if (STUBS.has(dir)) continue;
    if (readFileSync(`${REPO_ROOT}${file}`, 'utf8').includes('extends ChatCompletionsProvider')) {
      dirs.add(dir);
    }
  }
  return dirs;
}

describe('the AI providers register their rate-limiter namespace at boot', () => {
  test('the tree was read — otherwise the reconciliation below is vacuous', () => {
    const dirs = aiProviderDirs();
    // A positive control: this directory exists and does extend the base.
    expect(dirs.has('ai-openai')).toBe(true);
    // A negative one, so the filter is doing work rather than matching all:
    // coingecko is a real directory that does NOT extend the base.
    expect(dirs.has('coingecko')).toBe(false);
  });

  test('every AI provider directory is covered by a factory under test', () => {
    // The reconciliation. A fourth OpenAI-compatible provider added without a
    // line here fails this rather than quietly re-opening SC-1090.
    const tested = new Set(AI_FACTORIES.map(([dir]) => dir));
    expect([...aiProviderDirs()].sort()).toEqual([...tested].sort());
  });

  for (const [dir, factory, envVar] of AI_FACTORIES) {
    test(`${dir} registers ai:${dir} when booted`, async () => {
      const registry = new RateLimiterRegistry();
      await factory(makeDeps(registry, { [envVar]: 'test-key' }));

      const entries = registry.list();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.namespace).toBe(`ai:${dir}`);
      // Same `providers/<dir>` convention the other 25 use, so a duplicate
      // conflict names a findable call site rather than "the AI base".
      expect(entries[0]?.registeredFrom).toBe(`providers/${dir}`);
      // The description is what the admin's inventory renders; an empty one
      // is a row that says nothing.
      expect(entries[0]?.description?.length ?? 0).toBeGreaterThan(0);
    });

    test(`${dir} registers even with no API key — boot does not depend on config`, async () => {
      // The keyless branch is the one a change is most likely to drop: nothing
      // visibly breaks, the inventory just quietly stops naming this provider.
      const registry = new RateLimiterRegistry();
      await factory(makeDeps(registry, {}));
      expect(registry.list().map((e) => e.namespace)).toEqual([`ai:${dir}`]);
    });
  }

  test('all three share one registry without colliding, and list() carries all three', async () => {
    const registry = new RateLimiterRegistry();
    for (const [, factory] of AI_FACTORIES) {
      await factory(makeDeps(registry, {}));
    }
    expect(
      registry
        .list()
        .map((e) => e.namespace)
        .sort()
    ).toEqual(['ai:ai-deepseek', 'ai:ai-openai', 'ai:ai-perplexity']);
    // `get()` resolving is what makes the entry useful rather than decorative.
    expect(registry.get('ai:ai-openai')).not.toBeNull();
  });

  test('direct construction registers nothing — registration belongs to boot', () => {
    // `new OpenAIProvider(key)` is what the other tests in this suite do, and
    // it must stay side-effect-free: registering from a bare `new` would make
    // a second construction in one process throw on the first one's namespace.
    const registry = new RateLimiterRegistry();
    new OpenAIProvider('test-key');
    expect(registry.list()).toEqual([]);
  });
});
