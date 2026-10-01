import { appendFileSync, readFileSync } from 'node:fs';

/**
 * The release a `docker-publish.yml` run publishes, checked before any image is
 * built (SC-1484).
 *
 * On a `v*` tag the version is the tag, and it must be bare semver and agree
 * with `.release-please-manifest.json`; anything else fails the run, so no
 * image is pushed under a release it cannot name. Any other ref builds without
 * pushing, and its images claim no release.
 */

const TAG_PREFIX = 'refs/tags/v';

export type ReleaseVersion = { ok: true; version: string } | { ok: false; error: string };

export function releaseVersion(ref: string, manifestVersion: unknown): ReleaseVersion {
  if (!ref.startsWith(TAG_PREFIX)) return { ok: true, version: '' };
  const tag = ref.slice(TAG_PREFIX.length);
  if (!/^\d+\.\d+\.\d+$/.test(tag)) {
    return { ok: false, error: `tag v${tag} is not a bare semver release tag` };
  }
  if (tag !== manifestVersion) {
    return {
      ok: false,
      error: `tag v${tag} disagrees with .release-please-manifest.json, which names ${JSON.stringify(manifestVersion)}`,
    };
  }
  return { ok: true, version: tag };
}

if (import.meta.main) {
  const manifest = JSON.parse(readFileSync('.release-please-manifest.json', 'utf8'));
  const result = releaseVersion(process.env.GITHUB_REF ?? '', manifest['.']);
  if (!result.ok) {
    console.error(`release-version: ${result.error}. Nothing is published.`);
    process.exit(1);
  }
  console.log(`release-version: ${result.version || '(none — this ref publishes nothing)'}`);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `version=${result.version}\n`);
}
