import { apiBaseUrl } from './api-base-url';

/**
 * Where an institution's mark comes from (SC-208).
 *
 * This used to be `www.google.com/s2/favicons?domain=<host>`, which made every
 * row of the holdings table a third-party request to google.com from a finance
 * app: exactly the shape content blockers exist to stop, unreachable from
 * China, and an undocumented endpoint that had already changed under us once
 * (the 301 behind SC-203). The api now resolves and serves these itself.
 *
 * **Keyed on the institution id, not its website.** The server takes the
 * website from the row rather than from the caller, so this URL cannot be used
 * to make the backend fetch an arbitrary address.
 *
 * `website` is still read, and only to decide whether to ask at all: an
 * institution with no site has no icon, and skipping the request means the
 * letter tile is drawn immediately instead of after a round trip. A row that
 * has a website but no resolvable icon gets a 404 and the same letter tile,
 * one request later.
 */
export interface InstitutionIconSubject {
  id: string;
  website?: string | null;
}

/**
 * The pure half, taking its base as an argument — same split as
 * `resolveApiBaseUrl`, and for the same reason: the URL shape is worth
 * asserting without a build's `import.meta.env`.
 */
export function buildInstitutionIconUrl(
  apiBase: string,
  institution: InstitutionIconSubject | null | undefined
): string | null {
  if (!institution?.website) return null;
  return `${apiBase}/institution-icons/${encodeURIComponent(institution.id)}`;
}

export function institutionIconUrl(
  institution: InstitutionIconSubject | null | undefined
): string | null {
  if (!institution?.website) return null;
  let base: string;
  try {
    base = apiBaseUrl();
  } catch {
    // `apiBaseUrl` throws when `VITE_API_URL` is absent, and this is called
    // from render — so without this catch a missing build-time variable turns
    // every institution row into an error boundary. SC-453 is what a throw on
    // this path costs: `createAuthClient({ baseURL: '/api' })` threw during
    // module evaluation and the whole app was a white screen with nothing in
    // the console but that line.
    //
    // A mark is not worth that. The letter tile is already the documented
    // fallback for an icon we cannot produce, and this is one more reason we
    // cannot produce one.
    return null;
  }
  return buildInstitutionIconUrl(base, institution);
}
