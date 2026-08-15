import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { parsePeekId, peekOpenState, peekPath, resolvePeekClose } from '../lib/peek';
import { useReturnFocus } from './useReturnFocus';

/**
 * Binds the peek sheet to the URL.
 *
 * All the decisions are in `lib/peek.ts`; this is the two router calls that
 * cannot be pure. `basePath` is optional so a surface without a peek still
 * calls the hook unconditionally — the alternative is a conditional hook, and
 * the alternative to *that* is every list surface repeating the wiring.
 */
export function usePeekRoute(basePath: string | undefined) {
  const location = useLocation();
  const navigate = useNavigate();

  const id = basePath ? parsePeekId(location.pathname, basePath) : null;
  // The row that opened the peek gets focus back when it closes — see
  // `useReturnFocus` (SC-71 5.3).
  const captureTrigger = useReturnFocus(id !== null);

  const open = useCallback(
    (recordId: string) => {
      if (!basePath) return;
      captureTrigger();
      navigate(peekPath(basePath, recordId, location.search), {
        state: peekOpenState(basePath),
      });
    },
    [basePath, captureTrigger, location.search, navigate]
  );

  const close = useCallback(() => {
    if (!basePath) return;
    const action = resolvePeekClose(basePath, location.state);
    if (action.type === 'back') navigate(-1);
    else navigate(action.to, { replace: true });
  }, [basePath, location.state, navigate]);

  return { id, open, close };
}
