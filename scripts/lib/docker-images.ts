#!/usr/bin/env bun

//
// The one list of images this repo publishes to Docker Hub.
//
// Everything else that states the set is a CONSUMER of this file, not a
// second copy of it:
//
//   scripts/publish-images-local.sh       reads the TSV this file prints
//   scripts/sync-dockerhub-readme.ts      imports DOCKER_IMAGES
//   docker-readmes/<image>.md             reconciled against it, both ways
//   .github/workflows/docker-publish.yml  matrix, pinned by
//     scripts/tests/docker-images.test.ts against this list
//
// SC-534, and the reason a count is not evidence. The README sync used to
// build its work list with `readdirSync('docker-readmes')` and never compared
// it against anything. A missing README was therefore not an error — it was a
// smaller number in a line that reads fine at any value:
//
//     Loaded 1 README(s) from docker-readmes/
//
// That was the real output over five published images. Exit 0, four Docker Hub
// descriptions silently unsynced. `Loaded 1` cannot be told apart from
// `Loaded 5` without knowing what 5 should be, and this file is what knows.
//
// Run directly to get the list as `<image>\t<dockerfile>` lines, which is how
// the shell script consumes it.
//

export interface DockerImage {
  /** Docker Hub repository, under the `scani/` namespace. */
  readonly image: string;
  /** Build recipe for it, repo-root-relative. */
  readonly dockerfile: string;
}

export const DOCKER_IMAGES: readonly DockerImage[] = [
  { image: 'api', dockerfile: 'apps/backend/api/Dockerfile' },
  { image: 'worker', dockerfile: 'apps/backend/worker/Dockerfile' },
  { image: 'data-provider', dockerfile: 'apps/backend/data-provider/Dockerfile' },
  { image: 'frontend-app', dockerfile: 'apps/frontend/app/Dockerfile' },
  { image: 'migrate', dockerfile: 'packages/infra/db/Dockerfile.migrate' },
];

export interface ManifestDiff {
  /** Declared here, absent from the set being checked. */
  readonly missing: readonly string[];
  /** Present in the set being checked, declared nowhere here. */
  readonly unexpected: readonly string[];
}

/**
 * Compare some other statement of the image set against this one.
 *
 * An EMPTY manifest is reported as a mismatch even against an empty input.
 * Nothing here can produce that today — the list is a literal — but the whole
 * defect this file exists for is a check that agrees with a set derived from
 * nothing, and `0 === 0` is the shape it would take next time.
 */
export function diffAgainstManifest(actual: Iterable<string>): ManifestDiff {
  const declared = DOCKER_IMAGES.map((i) => i.image);
  if (declared.length === 0) {
    return { missing: ['<the manifest declares no images at all>'], unexpected: [...actual] };
  }
  const have = new Set(actual);
  return {
    missing: declared.filter((image) => !have.has(image)),
    unexpected: [...have].filter((image) => !declared.includes(image)).sort(),
  };
}

if (import.meta.main) {
  for (const { image, dockerfile } of DOCKER_IMAGES) {
    console.log(`${image}\t${dockerfile}`);
  }
}

/**
 * SC-545. Two PROSE copies of this set are hand-maintained and were checked by
 * nothing: `docs/PUBLISHING.md`'s table and the header comment above
 * `.github/workflows/docker-publish.yml`'s matrix. The matrix itself is pinned;
 * the comment describing it was not, and had already drifted — it said the
 * publish token needs write on "the four `scani/*` repos" over five images.
 *
 * Deliberately NARROW on counts. Both files carry historical narrative whose
 * numbers are correct and have nothing to do with this set — "four missing
 * files", "four Docker Hub descriptions", "six of six runs", "one green check".
 * A proximity rule reads those as claims and reds on prose that is right, and a
 * check whose every failure is expected stops being read. So a number word
 * counts only when it directly qualifies an image-set noun.
 */
const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
] as const;

/** `scani/api`, never `scani/*` or `scani/${{ matrix.image }}`. */
const IMAGE_MENTION = /\bscani\/([a-z0-9][a-z0-9-]*)/g;

const COUNT_CLAIM = new RegExp(
  `\\b(${NUMBER_WORDS.join('|')})\\b\\s+(?:\`?scani[/*\`]*\`?\\s+|Scani\\s+)?(?:images?|repos?)\\b`,
  'gi'
);

export interface ProseDiff extends ManifestDiff {
  /** Declared dockerfiles the prose never names. */
  readonly missingDockerfiles: readonly string[];
  /** Count claims disagreeing with the manifest, quoted as written. */
  readonly wrongCounts: readonly string[];
  /** What the scan actually SAW, so a caller can refuse to pass on nothing. */
  readonly read: { readonly images: number; readonly counts: number };
}

/**
 * Compare a prose statement of the image set — a markdown table, a comment
 * block — against this manifest.
 *
 * `read.images` is the vacuity guard and the reason it is returned rather than
 * asserted here: a scrape that stops matching returns an empty list, and an
 * empty list agrees with everything. The caller decides, and says so.
 */
export function diffProseAgainstManifest(text: string): ProseDiff {
  const named = Array.from(text.matchAll(IMAGE_MENTION)).flatMap((m) => m[1] ?? []);
  // YAML comment markers and line breaks must not hide a claim spanning them.
  const flattened = text.replace(/^[ \t]*#[ \t]?/gm, '').replace(/\s+/g, ' ');
  const claims = Array.from(flattened.matchAll(COUNT_CLAIM)).map((m) => m[0]);

  const expected = DOCKER_IMAGES.length;
  const wordFor = NUMBER_WORDS[expected] ?? String(expected);

  return {
    ...diffAgainstManifest(named),
    missingDockerfiles: DOCKER_IMAGES.filter((i) => !text.includes(i.dockerfile)).map(
      (i) => i.dockerfile
    ),
    wrongCounts: claims.filter(
      (claim) => (claim.match(/^\S+/)?.[0] ?? '').toLowerCase() !== wordFor
    ),
    read: { images: named.length, counts: claims.length },
  };
}
