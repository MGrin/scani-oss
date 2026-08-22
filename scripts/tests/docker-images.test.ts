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
import { DOCKER_IMAGES, diffAgainstManifest } from '../lib/docker-images';

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
