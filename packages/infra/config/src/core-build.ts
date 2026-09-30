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
