#!/usr/bin/env bun

//
// Pushes per-image README content from `docker-readmes/<image>.md` to
// the corresponding `scani/<image>` repository on Docker Hub.
//
// Each markdown file has this shape:
//
//   <!-- description: short description, ≤100 chars -->
//
//   # full markdown body
//   ...
//
// The HTML comment becomes Docker Hub's `description` field (the one
// shown in search results). The rest of the file becomes
// `full_description` (the long README rendered on the repo page).
//
// Usage:
//   DOCKERHUB_USERNAME=… DOCKERHUB_TOKEN=… bun scripts/sync-dockerhub-readme.ts
//   bun scripts/sync-dockerhub-readme.ts --check    # validate files only, no API calls
//   bun scripts/sync-dockerhub-readme.ts --only api # sync a single image
//
// The GitHub Action `.github/workflows/sync-dockerhub-readmes.yml` runs
// this on every push to `main` that touches `docker-readmes/**`.
//
// The image set comes from `scripts/lib/docker-images.ts`, and a README with
// no image or an image with no README is a non-zero exit naming the offender
// (SC-534) — not a smaller count in a line that reads fine either way.
//

import { readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { DOCKER_IMAGES, diffAgainstManifest } from './lib/docker-images';

const NAMESPACE = 'scani';
const README_DIR = resolve(import.meta.dir, '..', 'docker-readmes');
const HUB_API = 'https://hub.docker.com/v2';
const DESCRIPTION_LIMIT = 100;
const DESCRIPTION_RE = /^<!--\s*description:\s*(.+?)\s*-->\s*$/m;

type ReadmeFile = {
  image: string;
  path: string;
  description: string;
  fullDescription: string;
};

function parseReadme(path: string): ReadmeFile {
  const image = basename(path, '.md');
  const raw = readFileSync(path, 'utf8');
  const match = raw.match(DESCRIPTION_RE);
  if (!match) {
    throw new Error(
      `${path}: missing leading "<!-- description: ... -->" comment. ` +
        `The HTML comment becomes Docker Hub's short description.`
    );
  }
  const description = match[1];
  if (description.length > DESCRIPTION_LIMIT) {
    throw new Error(
      `${path}: description is ${description.length} chars, Docker Hub caps at ${DESCRIPTION_LIMIT}. ` +
        `Trim: "${description}"`
    );
  }
  // Strip the comment line + any blank line that follows so the rendered
  // README on the Hub page doesn't show the HTML comment.
  const fullDescription = raw
    .replace(DESCRIPTION_RE, '')
    .replace(/^\s*\n/, '')
    .trimEnd();
  return { image, path, description, fullDescription };
}

/**
 * Every file in `docker-readmes/` must be an image, and every image must have
 * a file. SC-534: without this the work list was whatever the directory
 * happened to hold, so a missing README came out as a smaller count and exit
 * 0 rather than as an error.
 *
 * This runs on the WHOLE directory even under `--only`, and that is
 * deliberate: `--only` narrows what gets pushed, not what is true about the
 * tree. Softening it so a single-image sync can proceed over a gap would
 * restore the defect for the one invocation most likely to be reached for
 * while something is already broken.
 */
function assertEveryImageHasAReadme(readmes: readonly ReadmeFile[]): void {
  const { missing, unexpected } = diffAgainstManifest(readmes.map((r) => r.image));
  if (missing.length === 0 && unexpected.length === 0) return;
  const dockerfileFor = new Map(DOCKER_IMAGES.map((i) => [i.image, i.dockerfile]));
  throw new Error(
    [
      `docker-readmes/ does not match the ${DOCKER_IMAGES.length} image(s) declared in scripts/lib/docker-images.ts:`,
      ...missing.map(
        (image) =>
          `  scani/${image} has no README — create docker-readmes/${image}.md ` +
          `(built from ${dockerfileFor.get(image) ?? 'an undeclared Dockerfile'})`
      ),
      ...unexpected.map(
        (image) =>
          `  docker-readmes/${image}.md has no image — add ${image} to ` +
          `scripts/lib/docker-images.ts, or delete the file`
      ),
    ].join('\n')
  );
}

function loadReadmes(only: string | null): ReadmeFile[] {
  const files = readdirSync(README_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();
  const parsed = files.map((f) => parseReadme(resolve(README_DIR, f)));
  assertEveryImageHasAReadme(parsed);
  if (only) {
    const match = parsed.find((p) => p.image === only);
    if (!match) {
      throw new Error(
        `--only ${only}: no docker-readmes/${only}.md. ` +
          `Available: ${parsed.map((p) => p.image).join(', ')}`
      );
    }
    return [match];
  }
  return parsed;
}

async function login(username: string, token: string): Promise<string> {
  const res = await fetch(`${HUB_API}/users/login/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: token }),
  });
  if (!res.ok) {
    throw new Error(`Docker Hub login failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token?: string };
  if (!body.token) {
    throw new Error(`Docker Hub login returned no token: ${JSON.stringify(body)}`);
  }
  return body.token;
}

type PatchResult = 'updated' | 'skipped-missing-repo';

async function patchRepo(jwt: string, readme: ReadmeFile): Promise<PatchResult> {
  const url = `${HUB_API}/repositories/${NAMESPACE}/${readme.image}/`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `JWT ${jwt}`,
    },
    body: JSON.stringify({
      description: readme.description,
      full_description: readme.fullDescription,
    }),
  });
  if (res.status === 404) {
    // Docker Hub auto-creates repos on first image push, not on README PATCH.
    // A README can land before its image does (e.g. when a new image is added
    // to docker-publish.yml but no `v*` tag has been cut yet). Treat as a
    // soft skip — the next sync run after the first publish will populate it.
    return 'skipped-missing-repo';
  }
  if (!res.ok) {
    throw new Error(`PATCH ${NAMESPACE}/${readme.image} failed: ${res.status} ${await res.text()}`);
  }
  return 'updated';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? null) : null;

  const readmes = loadReadmes(only);
  // Not `Loaded N README(s)`. That line was true at every N and told a reader
  // nothing about whether N was all of them (SC-534) — so it names the set it
  // reconciled against, and syncing a subset says so.
  console.log(
    `docker-readmes/ covers all ${DOCKER_IMAGES.length} published image(s): ` +
      `${DOCKER_IMAGES.map((i) => i.image).join(', ')}`
  );
  if (only) console.log(`--only ${only}: syncing 1 of them.`);
  for (const r of readmes) {
    console.log(
      `  scani/${r.image.padEnd(14)} desc=${r.description.length}c body=${r.fullDescription.length}c`
    );
  }

  if (checkOnly) {
    console.log('--check: validation passed, no API calls made.');
    return;
  }

  const username = process.env.DOCKERHUB_USERNAME;
  const token = process.env.DOCKERHUB_TOKEN;
  if (!username || !token) {
    throw new Error(
      'DOCKERHUB_USERNAME and DOCKERHUB_TOKEN must be set. ' +
        'Create a token at https://hub.docker.com/settings/personal-access-tokens with ' +
        'read/write scope on the scani/* repos.'
    );
  }

  const jwt = await login(username, token);
  console.log('Logged in to Docker Hub.');

  let updated = 0;
  let skipped = 0;
  for (const r of readmes) {
    const result = await patchRepo(jwt, r);
    if (result === 'updated') {
      updated += 1;
      console.log(`  ✓ updated scani/${r.image}`);
    } else {
      skipped += 1;
      console.log(
        `  ⚠ skipped scani/${r.image} — repo does not exist yet on Docker Hub. ` +
          `It will be created on the next image push; re-run this sync afterwards.`
      );
    }
  }
  console.log(`Done. updated=${updated} skipped=${skipped}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
