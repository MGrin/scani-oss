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

/**
 * The same facts as the host serves them now, from `/version.json` (SC-1588).
 * A release that changes no app code keeps the page's `version`, so no update
 * is offered and the page is not reloaded; the meta tag then names the release
 * the page loaded with. `null` when the host cannot be read, so the caller
 * keeps the page's own identity rather than claiming nothing.
 */
export async function servedBuildIdentity(): Promise<BuildIdentity | null> {
  try {
    const response = await fetch('/version.json', { cache: 'no-store' });
    if (!response.ok) return null;
    const served = (await response.json()) as {
      commit?: string;
      coreBuild?: CoreBuildIdentity;
    };
    if (!served.commit && !served.coreBuild) return null;
    return {
      commit: served.commit ?? null,
      coreBuild: served.coreBuild ?? null,
      sentryRelease: null,
    };
  } catch {
    return null;
  }
}
