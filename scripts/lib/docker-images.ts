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
