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

import { readdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

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

function loadReadmes(only: string | null): ReadmeFile[] {
  const files = readdirSync(README_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();
  const parsed = files.map((f) => parseReadme(resolve(README_DIR, f)));
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
  console.log(`Loaded ${readmes.length} README(s) from docker-readmes/`);
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
