/**
 * What `viteVersion` writes into `index.html` as `<meta name="scani-build">`:
 * the facts that change on every commit, read at runtime so no chunk carries
 * them (SC-1521). A page with no tag, or a tag it cannot parse, is a build
 * that names nothing, which reads as Development rather than as an error.
 */
export interface CoreBuildIdentity {
  readonly productVersion: string;
  readonly releaseCommit: string;
  readonly coreFingerprint: string;
  readonly pendingChangeCount: number;
}

export interface BuildIdentity {
  readonly commit: string | null;
  readonly coreBuild: CoreBuildIdentity | null;
  readonly sentryRelease: string | null;
}

const NONE: BuildIdentity = { commit: null, coreBuild: null, sentryRelease: null };

export function buildIdentity(): BuildIdentity {
  if (typeof document === 'undefined') return NONE;
  const content = document.querySelector<HTMLMetaElement>('meta[name="scani-build"]')?.content;
  if (!content) return NONE;
  try {
    const parsed = JSON.parse(content) as Partial<BuildIdentity>;
    return {
      commit: parsed.commit ?? null,
      coreBuild: parsed.coreBuild ?? null,
      sentryRelease: parsed.sentryRelease ?? null,
    };
  } catch {
    return NONE;
  }
}
