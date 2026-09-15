import { createContext, useContext } from 'react';
import type { AuthContextType } from '@/contexts/AuthContext';

/**
 * The auth context OBJECT, apart from the provider that fills it (SC-1207).
 *
 * `AuthContext.tsx` imports `auth-client`, which builds the Better-Auth client
 * at module scope and throws when `VITE_API_URL` is unset. So anything that
 * loads that file to ask one question — is this the demo? — can crash where
 * the variable is missing. Private checkouts carry it in `.env`, so their test
 * runs never saw this. The public mirror's CI does not, and there
 * `DemoCaptureNote` took down every test file that renders a capture form.
 * This module's only runtime import is React, so the question costs nothing to
 * ask.
 */
export const AuthContext = createContext<AuthContextType | undefined>(undefined);

/**
 * Is this the demo — asked from a component that may render without the
 * provider above it (SC-1207).
 *
 * `useAuth` throws in that case, which is right for anything that needs a
 * session: a sign-out button with nowhere to send the request is a bug, not a
 * variant. A demo NOTICE is the other shape — it is an additive label, and no
 * provider means no `demo.status` probe has run, so the honest answer is "not
 * the demo" rather than an exception. The safe direction: a missing label
 * costs a sentence, a wrongly-shown one tells a paying user their data is not
 * being saved.
 */
export function useIsDemo(): boolean {
  return useContext(AuthContext)?.isDemo ?? false;
}
