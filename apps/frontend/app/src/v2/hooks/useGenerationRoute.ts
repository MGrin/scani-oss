import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { counterpartPath, uiVersionForPath } from '@/v3/lib/ui-version';

/**
 * Rewrites a `V2_ROUTES` path into whichever generation is currently on screen.
 *
 * The job-result renderers under `v2/components/jobs/` are shared, not v2's:
 * `resolveV3ReviewRenderer` delegates all but one job kind straight to v2's
 * registry, so the same component renders inside the v3 shell. Their onward
 * navigation was written against `V2_ROUTES` and therefore always absolute to
 * `/v2` — so a v3 reader who finished an import was ejected into the classic UI
 * by the confirmation of their own success (SC-134). On a phone that swapped
 * three of five tab-bar labels under their thumb.
 *
 * `counterpartPath` is the existing crossing rule and does the work; this hook
 * only supplies the target from the URL being rendered and splits off a query
 * string, which those paths carry (`/holdings?account=<id>`). A v2 path is
 * returned untouched when v2 is what is rendering, so the classic UI is
 * byte-identical.
 *
 * Best-effort by inheritance: a v2 screen v3 never built falls back to the v3
 * home rather than to a blank route. That is the same answer the version switch
 * gives, and the alternative — sending the reader to a `/v2` URL — is the bug.
 */
export function useGenerationPath(): (v2Path: string) => string {
  const { pathname } = useLocation();
  const target = uiVersionForPath(pathname);
  return useCallback(
    (v2Path: string) => {
      const queryAt = v2Path.indexOf('?');
      if (queryAt === -1) return counterpartPath(v2Path, target);
      return counterpartPath(v2Path.slice(0, queryAt), target, v2Path.slice(queryAt));
    },
    [target]
  );
}

/** `useNavigate` with the same rewrite applied. */
export function useGenerationNavigate(): (v2Path: string) => void {
  const navigate = useNavigate();
  const toGeneration = useGenerationPath();
  return useCallback((v2Path: string) => navigate(toGeneration(v2Path)), [navigate, toGeneration]);
}
