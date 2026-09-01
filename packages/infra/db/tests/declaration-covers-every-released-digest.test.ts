import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import path from 'node:path';
import { DRIFT_DECLARATIONS } from '../src/migration-reconciliation';

/**
 * SC-917. A drift declaration's `recorded` is a claim about what a DATABASE
 * HOLDS RIGHT NOW — not about what this repo shipped. The two stop being the
 * same the moment a declaration fires, and nothing in the existing suite
 * noticed the difference.
 *
 * How that bit: `0044_sc328_pair_kraken_eth_withdrawals` shipped three times —
 * the original, the SC-915 comment scrub, and SC-917's identifier scrub. The
 * comment-only declaration covering the first hop had to be replaced, because
 * its `sqlSha256` no longer describes the file. Deriving the replacement's
 * `recorded` from "the commit carrying the text this repo shipped" produced the
 * ORIGINAL digest — sound-looking, and it agreed with the entry being replaced,
 * which is what made it convincing. But that entry had already done its job on
 * both deployed databases and moved them to the SC-915 digest. So the
 * declaration covered the one population that no longer existed;
 * `planReconciliation` filters candidates on `tag` AND `recorded`, so the real
 * drift matched nothing, fell into `refuse`, and would have failed the whole
 * deploy — the mechanism producing the outage it exists to prevent.
 *
 * Every check in `migration-reconciliation.test.ts` passed throughout. They ask
 * whether each declaration is internally consistent and still describes its
 * file; none asks whether the declarations, taken together, cover the states a
 * real database can be in.
 *
 * WHY RELEASE TAGS ARE THE ANCHOR, and not the commit history. A version of a
 * migration is only a risk if something ran it, and what ran is what SHIPPED. A
 * blob that existed on `main` between two merges was never deployed and needs
 * no declaration; requiring one would make this fail for two unrelated
 * migrations that carry exactly such intermediates (`0040`, `0045`), which is
 * noise, not signal. Every release tag is checked rather than a window of the
 * last few — measured across all 43, the only uncovered digest is the one this
 * ticket is about, so a window would only be an arbitrary place to stop.
 *
 * WHAT THIS CANNOT SEE: a database that deployed from an untagged commit, and
 * one running a release older than any tag here. Both are outside what the repo
 * records, and neither is softened into a pass — the check simply does not
 * claim them.
 */

setDefaultTimeout(30_000);

const REPO = path.resolve(import.meta.dir, '../../../..');
const MIGRATION = (tag: string) => `packages/infra/db/src/migrations/${tag}.sql`;

/**
 * A git that FAILED is not a git that answered nothing (SC-884). CI's `test`
 * job checks out at `fetch-depth: 0` precisely so guards like this one can read
 * history; if that ever changes, this must name the git command rather than
 * degrade toward "no releases, nothing to check", which is a vacuous pass.
 */
function git(args: string[], stdin?: string): string {
  const run = Bun.spawnSync(['git', ...args], {
    cwd: REPO,
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
  });
  if (!run.success) {
    const why = new TextDecoder().decode(run.stderr).trim() || '<no message>';
    throw new Error(`git ${args.join(' ')} exited ${run.exitCode}: ${why}`);
  }
  return new TextDecoder().decode(run.stdout);
}

const releases = git(['tag', '--list', 'v*']).split('\n').filter(Boolean);
const declaredTags = [...new Set(DRIFT_DECLARATIONS.map((d) => d.tag))];

/**
 * Blob id per `<release>:<migration>`, in ONE subprocess. Content is fetched
 * only for the blobs that differ from HEAD, so this is two `git` calls rather
 * than one per release per migration (817 specs, 38 unique blobs, ~0.35s).
 * Subprocess spawn is what amplifies under load here, not CPU (SC-694).
 */
function blobIds(specs: readonly string[]): Map<string, string> {
  const lines = git(['cat-file', '--batch-check'], `${specs.join('\n')}\n`).split('\n');
  const byId = new Map<string, string>();
  specs.forEach((spec, i) => {
    const first = lines[i]?.split(' ')[0];
    // A release predating the migration reports `missing` — legitimately
    // nothing to cover, not a failure.
    if (first && !lines[i]?.includes('missing')) byId.set(spec, first);
  });
  return byId;
}

function sha256OfBlob(id: string): string {
  const run = Bun.spawnSync(['git', 'cat-file', 'blob', id], { cwd: REPO });
  if (!run.success) throw new Error(`git cat-file blob ${id} failed`);
  return new Bun.CryptoHasher('sha256').update(run.stdout).digest('hex');
}

describe('every released digest of a declared migration is reconcilable', () => {
  test('release tags are readable, so this test can actually fail', () => {
    // Without this, a checkout with no tags would report zero gaps and read as
    // a pass. The control has to be able to come back red for the right reason.
    expect(releases.length).toBeGreaterThan(0);
    expect(declaredTags.length).toBeGreaterThan(0);
  });

  test('no released version of a declared migration is left uncovered', () => {
    const specs = releases.flatMap((rel) => declaredTags.map((tag) => `${rel}:${MIGRATION(tag)}`));
    const ids = blobIds(specs);
    const headId = new Map(
      declaredTags.map((tag) => [tag, git(['rev-parse', `HEAD:${MIGRATION(tag)}`]).trim()])
    );
    const digestOf = new Map<string, string>();

    const gaps: string[] = [];
    for (const rel of releases) {
      for (const tag of declaredTags) {
        const id = ids.get(`${rel}:${MIGRATION(tag)}`);
        // Identical blob to HEAD means this release is not drifted at all.
        if (!id || id === headId.get(tag)) continue;
        let digest = digestOf.get(id);
        if (digest === undefined) {
          digest = sha256OfBlob(id);
          digestOf.set(id, digest);
        }
        const covered = DRIFT_DECLARATIONS.some((d) => d.tag === tag && d.recorded === digest);
        if (!covered) gaps.push(`${tag} as shipped in ${rel} (recorded ${digest})`);
      }
    }

    expect(gaps).toEqual([]);
  });
});
