import { describe, expect, test } from 'bun:test';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DOCKER_IMAGES, diffAgainstManifest, diffProseAgainstManifest } from '../lib/docker-images';

/**
 * SC-534. `scripts/sync-dockerhub-readme.ts` built its work list with
 * `readdirSync('docker-readmes')` and compared it against nothing, so a
 * missing README was not an error — it was a smaller number in
 * `Loaded N README(s)`, a line that reads fine at every N. Four Docker Hub
 * descriptions sat unsynced behind `Loaded 1 README(s)` and exit 0.
 *
 * `scripts/lib/docker-images.ts` is now the one declaration of the set. What
 * follows pins the two properties that makes it worth having:
 *
 *   1. a README with no image, or an image with no README, exits non-zero
 *      and names the offender;
 *   2. every other statement of the set is DERIVED from it, not agreeing
 *      with it — the shell script reads it, the publish workflow's matrix is
 *      pinned against it, and this tree's `docker-readmes/` is reconciled.
 *
 * Every assertion here spawns the SHIPPED script. A re-implementation of the
 * reconciliation would agree with whatever the reconciliation got wrong.
 * Nothing here can reach Docker Hub: `--check` makes no API call, and the
 * publish script is only ever run with an argument that stops it at
 * validation, before its build-context guard and long before `docker`.
 */

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname, '..');
const MANIFEST = path.join(REPO_ROOT, 'scripts', 'lib', 'docker-images.ts');
const SYNC_SCRIPT = path.join(REPO_ROOT, 'scripts', 'sync-dockerhub-readme.ts');
const PUBLISH_SCRIPT = path.join(REPO_ROOT, 'scripts', 'publish-images-local.sh');
const README_DIR = path.join(REPO_ROOT, 'docker-readmes');
const PUBLISH_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'docker-publish.yml');
const PRIVATE_MARKER = path.join(REPO_ROOT, '.private-repo');
const PUBLISHING_DOC = path.join(REPO_ROOT, 'docs', 'PUBLISHING.md');

interface Image {
  readonly image: string;
  readonly dockerfile: string;
}

interface Run {
  readonly code: number | null;
  readonly out: string;
}

/**
 * The shipped manifest with a different list of images in it.
 *
 * The DATA is swapped and the LOGIC is the real one, which is the point: a
 * fixture that reimplemented `diffAgainstManifest` would pass against its own
 * mistakes. The throw is not defensive noise — if the literal is ever
 * reformatted past this pattern, a silent no-op patch would leave every
 * fixture below running against the real five images and passing for the
 * wrong reason.
 */
function manifestWith(images: readonly Image[]): string {
  const source = readFileSync(MANIFEST, 'utf8');
  const body = images
    .map((i) => `  { image: '${i.image}', dockerfile: '${i.dockerfile}' },`)
    .join('\n');
  const patched = source.replace(
    /export const DOCKER_IMAGES: readonly DockerImage\[\] = \[[\s\S]*?\n\];/,
    `export const DOCKER_IMAGES: readonly DockerImage[] = [\n${body}\n];`
  );
  if (patched === source) {
    throw new Error(
      `fixture: the DOCKER_IMAGES literal in ${MANIFEST} moved — this patch matched nothing`
    );
  }
  return patched;
}

interface Fixture {
  /** Images the manifest declares. Omit for the shipped list. */
  readonly images?: readonly Image[];
  /** Image names to write a `docker-readmes/<name>.md` for. */
  readonly readmes: readonly string[];
}

function scaffold(fixture: Fixture): string {
  const root = mkdtempSync(path.join(tmpdir(), 'scani-docker-images-'));
  mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(path.join(root, 'docker-readmes'));

  writeFileSync(
    path.join(root, 'scripts', 'lib', 'docker-images.ts'),
    fixture.images ? manifestWith(fixture.images) : readFileSync(MANIFEST, 'utf8')
  );
  cpSync(SYNC_SCRIPT, path.join(root, 'scripts', 'sync-dockerhub-readme.ts'));
  cpSync(PUBLISH_SCRIPT, path.join(root, 'scripts', 'publish-images-local.sh'));

  for (const image of fixture.readmes) {
    writeFileSync(
      path.join(root, 'docker-readmes', `${image}.md`),
      `<!-- description: ${image} -->\n\n# ${image}\n`
    );
  }
  return root;
}

async function spawn(argv: readonly string[], cwd: string): Promise<Run> {
  const proc = Bun.spawn([...argv], {
    cwd,
    env: { ...process.env, DRY_RUN: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: `${stdout}${stderr}` };
}

async function sync(fixture: Fixture, ...args: string[]): Promise<Run> {
  const root = scaffold(fixture);
  try {
    return await spawn(
      ['bun', path.join(root, 'scripts', 'sync-dockerhub-readme.ts'), '--check', ...args],
      root
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * `publish-images-local.sh` with an image name it cannot know, which stops it
 * at argument validation and prints the set it derived. That happens before
 * the build-context guard, so no fixture here needs to look like a checkout.
 */
async function publishKnownImages(fixture: Fixture): Promise<Run> {
  const root = scaffold(fixture);
  try {
    return await spawn(
      [path.join(root, 'scripts', 'publish-images-local.sh'), '0.0.0', 'not-an-image'],
      root
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SHIPPED = DOCKER_IMAGES.map((i) => i.image);

describe('the published image set has one source', () => {
  test('this tree: every image has a README and every README has an image', () => {
    const onDisk = Array.from(new Bun.Glob('*.md').scanSync({ cwd: README_DIR })).map((f) =>
      f.replace(/\.md$/, '')
    );

    expect(diffAgainstManifest(onDisk)).toEqual({ missing: [], unexpected: [] });
  });

  test('the sync refuses an image with no README, and names it', async () => {
    const { code, out } = await sync({ readmes: SHIPPED.filter((i) => i !== 'api') });

    expect(out).toContain('scani/api has no README');
    expect(out).toContain('create docker-readmes/api.md');
    // The Dockerfile is in the message because the reader's next question,
    // when an image they have never heard of turns up, is where it comes from.
    expect(out).toContain('apps/backend/api/Dockerfile');
    expect(code).toBe(1);
  });

  test('the sync refuses a README with no image, and names it', async () => {
    const { code, out } = await sync({ readmes: [...SHIPPED, 'legacy'] });

    expect(out).toContain('docker-readmes/legacy.md has no image');
    expect(code).toBe(1);
  });

  test('a complete set passes and says which set it checked', async () => {
    const { code, out } = await sync({ readmes: SHIPPED });

    // The negative control for every refusal above. A reconciliation that
    // only ever refuses is indistinguishable from one that is broken.
    expect(code).toBe(0);
    expect(out).toContain(`covers all ${SHIPPED.length} published image(s)`);
    for (const image of SHIPPED) expect(out).toContain(image);
  });

  test('--only narrows what is pushed, never what is reconciled', async () => {
    // THIS IS THE TEST A FUTURE READER WILL WANT TO DELETE. `--only worker`
    // touches nothing to do with `api`, so refusing it looks officious.
    // Argue with this reason rather than with the assertion: `--only` is what
    // somebody reaches for when a sync has already gone wrong, so it is the
    // one invocation that must not be able to report success over a gap. It
    // is also how the original defect presented — a narrower set, reported
    // fine.
    const { code, out } = await sync(
      { readmes: SHIPPED.filter((i) => i !== 'api') },
      '--only',
      'worker'
    );

    expect(out).toContain('scani/api has no README');
    expect(code).toBe(1);
  });

  test('an empty manifest over an empty docker-readmes/ is not a pass', async () => {
    // 0 images and 0 READMEs agree perfectly, and `missing.length === 0 &&
    // unexpected.length === 0` is exactly true. A check that measures nothing
    // must not be able to report success — that is the whole failure this
    // ticket is about, one level down.
    const { code, out } = await sync({ images: [], readmes: [] });

    expect(out).toContain('declares no images at all');
    expect(code).toBe(1);
  });

  test('publish-images-local.sh derives its images from the manifest', async () => {
    const shipped = await publishKnownImages({ readmes: [] });
    expect(shipped.out).toContain(`Known: ${SHIPPED.join(' ')}`);
    expect(shipped.code).toBe(1);

    // The load-bearing half: a manifest naming something else moves the
    // script's list with it. Without this, a hard-coded array that happened
    // to match would pass the assertion above.
    const swapped = await publishKnownImages({
      images: [
        { image: 'alpha', dockerfile: 'a/Dockerfile' },
        { image: 'beta', dockerfile: 'b/Dockerfile' },
      ],
      readmes: [],
    });
    expect(swapped.out).toContain('Known: alpha beta');
    expect(swapped.out).not.toContain('api');
  });

  test('publish-images-local.sh refuses a manifest that names nothing', async () => {
    // An empty list would build nothing, push nothing and exit 0 — a publish
    // that reports success having done none of it.
    const { code, out } = await publishKnownImages({ images: [], readmes: [] });

    expect(out).toContain('names no images');
    expect(code).toBe(1);
  });

  test('the publish workflow and the manifest name the same images', () => {
    // The workflow lives in MGrin/scani-oss only: publishing `scani/*` from
    // the private tree is the one mistake with no undo (SC-478), so the
    // private repo carries the marker and no such workflow. Both trees get a
    // positive assertion here — an absent file is never read as a pass.
    if (existsSync(PRIVATE_MARKER)) {
      expect(existsSync(PUBLISH_WORKFLOW)).toBe(false);
      return;
    }

    expect(existsSync(PUBLISH_WORKFLOW)).toBe(true);
    const workflow = readFileSync(PUBLISH_WORKFLOW, 'utf8');
    const matrix = Array.from(
      workflow.matchAll(/^\s*- image:\s*(\S+)\s*\n\s*dockerfile:\s*(\S+)\s*$/gm)
    ).map(([, image, dockerfile]) => ({ image, dockerfile }));

    // A scrape that stops matching returns an empty list, which would make
    // every comparison below vacuous. It fails closed instead.
    expect(matrix.length).toBeGreaterThan(0);
    expect(matrix).toEqual(DOCKER_IMAGES.map((i) => ({ ...i })));
  });
});

/**
 * SC-545. The matrix is pinned; the PROSE that states the same set was not.
 * There are two copies and they live in different repositories —
 * `docs/PUBLISHING.md` is private-only, `docker-publish.yml` is upstream-only —
 * so no check can read both, and one that reads whichever it finds reports
 * clean on the repo that lacks its target.
 *
 * The answer is the one the matrix test above already uses: branch on
 * `.private-repo` and make a POSITIVE assertion on BOTH sides, so an absent
 * file is a fact each tree asserts rather than a check that quietly skipped.
 */
describe('the prose that states the image set agrees with the manifest', () => {
  function assertProseAgrees(file: string, label: string): void {
    const diff = diffProseAgainstManifest(readFileSync(file, 'utf8'));

    // FAIL CLOSED FIRST. A scrape that stops matching returns an empty list,
    // and an empty list agrees with every manifest — `missing: [], unexpected:
    // []` is exactly what a check reading nothing reports. This is the
    // denominator, asserted rather than printed beside a headline.
    //
    // `> 0` and not `=== DOCKER_IMAGES.length`: an exact count fires FIRST on a
    // prose copy naming a sixth image and reports `read 5 -> 6`, which is true
    // and does not name the offender. A PARTIAL scrape is caught by `missing`
    // below, with the images it failed to find listed.
    expect({ label, namedAnyImage: diff.read.images > 0 }).toEqual({ label, namedAnyImage: true });

    expect({
      label,
      missing: diff.missing,
      unexpected: diff.unexpected,
      missingDockerfiles: diff.missingDockerfiles,
      wrongCounts: diff.wrongCounts,
    }).toEqual({
      label,
      missing: [],
      unexpected: [],
      missingDockerfiles: [],
      wrongCounts: [],
    });
  }

  test('this tree states it in the one file this tree has', () => {
    if (existsSync(PRIVATE_MARKER)) {
      // Positive on both halves: the doc is here, and the workflow is not.
      expect(existsSync(PUBLISHING_DOC)).toBe(true);
      expect(existsSync(PUBLISH_WORKFLOW)).toBe(false);
      assertProseAgrees(PUBLISHING_DOC, 'docs/PUBLISHING.md');
      return;
    }

    expect(existsSync(PUBLISH_WORKFLOW)).toBe(true);
    expect(existsSync(PUBLISHING_DOC)).toBe(false);
    assertProseAgrees(PUBLISH_WORKFLOW, '.github/workflows/docker-publish.yml');
  });

  /**
   * THE CONTROLS. Every assertion above is a must-be-ABSENT — it passes when
   * nothing is found, which is also what a broken scrape does. These are the
   * must-be-FOUND half: the same function, over prose bent in each direction
   * the real thing can bend.
   */
  const TABLE = [
    'Five images are published under the `scani/` namespace:',
    ...DOCKER_IMAGES.map((i) => `| \`scani/${i.image}\` | \`${i.dockerfile}\` |`),
  ].join('\n');

  test('CONTROL — the unbent table passes, so the refusals below mean something', () => {
    const diff = diffProseAgainstManifest(TABLE);
    expect(diff.read.images).toBe(DOCKER_IMAGES.length);
    expect(diff).toMatchObject({ missing: [], unexpected: [], wrongCounts: [] });
  });

  test('a sixth image the manifest does not declare is reported', () => {
    const diff = diffProseAgainstManifest(`${TABLE}\n| \`scani/ghost\` | \`x/Dockerfile\` |`);
    expect(diff.unexpected).toEqual(['ghost']);
  });

  test('an image dropped from the prose is reported, and so is its Dockerfile', () => {
    const dropped = DOCKER_IMAGES[0];
    if (!dropped) throw new Error('fixture: the manifest declares no images');
    const diff = diffProseAgainstManifest(
      TABLE.split('\n')
        .filter((line) => !line.includes(`scani/${dropped.image}\``))
        .join('\n')
    );

    expect(diff.missing).toEqual([dropped.image]);
    expect(diff.missingDockerfiles).toEqual([dropped.dockerfile]);
  });

  test('a count word disagreeing with the manifest is reported, quoted as written', () => {
    const diff = diffProseAgainstManifest(TABLE.replace('Five images', 'Four images'));
    expect(diff.wrongCounts).toEqual(['Four images']);
  });

  test('the drift this was written for: "the four `scani/*` repos" over five images', () => {
    // Verbatim from `docker-publish.yml`, which said this while its own matrix
    // published five. Not hypothetical — the check found it on the real file.
    const diff = diffProseAgainstManifest(
      `${TABLE}\n# a token with read/write on the four \`scani/*\` repos`
    );
    expect(diff.wrongCounts).toEqual(['four `scani/*` repos']);
  });

  test('prose whose numbers are NOT about this set is left alone', () => {
    // The reason the count rule is narrow. Every number here is correct and
    // none is a claim about the image set; a proximity rule reds on all of
    // them, and a check whose failures are all expected stops being read.
    const diff = diffProseAgainstManifest(
      `${TABLE}\nfour missing files came out as one line, and six of six runs were held;\n` +
        'four Docker Hub descriptions sat stale, and a reader expecting nineteen sees one.'
    );
    expect(diff.wrongCounts).toEqual([]);
  });

  test('the workspace package `@scani/db` is not read as an image', () => {
    // Not hypothetical: `docker-compose.prod.yml` names `@scani/db` in a
    // comment beside five real image references. `\b` matches after the `@`,
    // so without the lookbehind this reports an unexpected image called `db`
    // and reds on a file that is correct.
    const diff = diffProseAgainstManifest(`${TABLE}\n# see \`@scani/db\` for the schema`);

    expect(diff.unexpected).toEqual([]);
    expect(diff.read.images).toBe(DOCKER_IMAGES.length);
  });

  test('prose naming nothing is not a pass', () => {
    // The vacuity case, asserted on the helper rather than only on the caller.
    const diff = diffProseAgainstManifest('This document mentions no images at all.');
    expect(diff.read.images).toBe(0);
    expect(diff.missing).toEqual(DOCKER_IMAGES.map((i) => i.image));
  });
});

/**
 * SC-705. SC-545 bound the two prose copies its ticket named. Enumerating the
 * tree found SEVEN files stating the whole published set — a name list is
 * exactly as wide as its entries, and that one was incomplete the day it was
 * written (the same finding as SC-609, one subject over).
 *
 * The assertion here is WEAKER than SC-545's on purpose. These files name the
 * images and not the build recipes, which is correct: a self-hosting page has
 * no business listing Dockerfile paths. So this checks the NAME set, and
 * `docs/PUBLISHING.md` / `docker-publish.yml` additionally carry SC-545's
 * stricter dockerfile-and-count assertion. Two properties, not two rules —
 * do not "de-duplicate" them by deleting one.
 *
 * WHY AN EXPLICIT LIST AND A SCAN, rather than either alone. Discovery keys on
 * "names every declared image", so a file that fails to add a SIXTH image drops
 * out of discovery — and a check that silently stops looking at a file is the
 * exact failure this family is about. Asserting the discovered set EQUALS the
 * expected one catches it from both sides: a copy that fell behind goes
 * missing, and a new copy nobody listed turns up.
 *
 * Discovery alone cannot be tightened into covering the partial namers, and
 * that is deliberate. Seven tracked files name three or four of the five and
 * are RIGHT to: the demo deployment brings up a subset, each
 * `docker-readmes/<x>.md` cross-links some siblings, and the dated pages under
 * `docs/implementation/` and `docs/technical/` are historical records that
 * `docs/README.md` forbids rewriting to match current infra.
 */
describe('every file that states the whole image set agrees with it', () => {
  /** Present, and stating the whole set, in BOTH trees. */
  const SHARED = [
    'apps/frontend/docs/src/content/docs/self-hosting/tier1/production.mdx',
    'apps/frontend/docs/src/content/docs/self-hosting/tier1/upgrades.md',
    'docker-compose.prod.yml',
    'docker-readmes/api.md',
  ];
  // `README.md` exists in BOTH trees and states the set only upstream — they
  // are independently maintained files, not one mirrored file, so this cannot
  // be expressed as "absent privately".
  const PRIVATE_ONLY = [
    'docs/PUBLISHING.md',
    'docs/SELF_HOST.md',
    'apps/frontend/landing/src/data/faq.ts',
  ];
  const UPSTREAM_ONLY = ['README.md', '.github/workflows/docker-publish.yml'];

  /** Tracked files naming every image the manifest declares. */
  function filesStatingTheSet(): string[] {
    const names = DOCKER_IMAGES.map((i) => i.image);
    const listed = Bun.spawnSync(['git', 'grep', '-lE', `scani/(${names.join('|')})`], {
      cwd: REPO_ROOT,
    })
      .stdout.toString()
      .split('\n')
      .filter(Boolean);

    return listed
      .filter((rel) => {
        const text = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
        return names.every((n) => new RegExp(`(?<!@)\\bscani/${n}\\b`).test(text));
      })
      .sort();
  }

  test('the tree carries exactly the copies this tree is expected to carry', () => {
    const expected = [
      ...SHARED,
      ...(existsSync(PRIVATE_MARKER) ? PRIVATE_ONLY : UPSTREAM_ONLY),
    ].sort();

    // Equality, not containment, and that is the whole design. A copy that
    // fell behind the manifest stops naming every image and DROPS OUT of the
    // scan — containment would read that as fine. A new copy nobody listed
    // turns up as an extra. Both are things somebody has to look at.
    expect(filesStatingTheSet()).toEqual(expected);
  });

  test('each of them names the declared images and nothing else', () => {
    const checked: string[] = [];
    for (const rel of filesStatingTheSet()) {
      const diff = diffProseAgainstManifest(readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
      // Not `missingDockerfiles` — see the block comment. `missing` is empty by
      // construction here; `unexpected` and `wrongCounts` are what can fire.
      expect({ rel, unexpected: diff.unexpected, wrongCounts: diff.wrongCounts }).toEqual({
        rel,
        unexpected: [],
        wrongCounts: [],
      });
      checked.push(rel);
    }

    // The denominator, asserted rather than printed beside a headline that is
    // already trusted (SC-699). An empty loop passes every expectation in it.
    // Per TREE, because the two carry different exclusive copies. A private
    // count asserted here passes privately and reds on the mirror — a SHARED
    // test file lands upstream green and only meets the other tree at the port
    // (SC-658), so this one is the count for whichever tree is running it.
    const exclusive = existsSync(PRIVATE_MARKER) ? PRIVATE_ONLY : UPSTREAM_ONLY;
    expect(checked.length).toBe(SHARED.length + exclusive.length);
  });
});
