import { z } from 'zod';

const coreBuildSchema = z
  .object({
    productVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    releaseCommit: z.string().regex(/^[0-9a-f]{40}$/),
    releaseFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    coreFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    pendingChangeCount: z.number().int().nonnegative(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();

export type CoreBuild = z.infer<typeof coreBuildSchema>;
export function readCoreBuild(
  raw: string | undefined,
  commit: string | undefined
): CoreBuild | undefined {
  if (!raw) return undefined;
  const mapping = coreBuildSchema.parse(JSON.parse(raw));
  if (mapping.commit !== commit)
    throw new Error('Core release mapping does not describe this build');
  return mapping;
}

/**
 * The release a public image was published as, from `SCANI_RELEASE_VERSION`,
 * which `docker-publish.yml` sets from the tag (SC-1484). `core-release.json`
 * never reaches the mirror, so a release image has no Core mapping to carry it.
 *
 * Unset means a local or self-built image, which claims no release. Set but
 * not semver is refused: a build that guessed would publish a label nobody can
 * trace.
 */
export function readReleaseVersion(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+\.\d+\.\d+$/.test(raw)) {
    throw new Error(`SCANI_RELEASE_VERSION must be a bare semver like 0.51.0; got '${raw}'`);
  }
  return raw;
}
