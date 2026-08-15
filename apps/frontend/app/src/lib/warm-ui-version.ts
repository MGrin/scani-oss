import { readCachedUser } from '@/lib/session-cache';
import { activeUiVersion, type UiVersion } from '@/v3/lib/ui-version';

/**
 * Start fetching the interface a returning reader is about to be shown, before
 * anything asks for it.
 *
 * Splitting v2 from v3 (SC-132 #2) moved 27% of the bundle behind a second
 * request — and measured **no improvement at all** for a signed-in reader,
 * because of *when* that request fires rather than how big it is. The generation
 * only renders below `ProtectedRoute`, which shows a spinner until the session
 * probe answers, so the chunk was not even requested until an API round trip had
 * completed. Bytes saved, an equal wait added, nothing gained: exactly the
 * "moves bytes without improving time-to-interactive" outcome the split was
 * required to avoid.
 *
 * Calling this from `main.tsx` moves the request to module-eval time, so it
 * overlaps the session probe instead of queueing behind it.
 *
 * **It is gated on the device having seen a session before** (`readCachedUser`,
 * the SC-78 hint) and that gate is the whole design. A first-time visitor gets
 * the sign-in form and never renders either generation, so warming one would
 * hand them a few hundred kilobytes they have no use for — which is the larger
 * of the two wins here and must not be spent. The hint is already exactly the
 * question being asked: *has this device been signed in?* It is not a
 * credential and is not treated as one — a wrong guess costs a prefetch, never
 * access.
 *
 * Failure is ignored on purpose. This is a head start, not a load: if it does
 * not arrive, `lazyRoute` requests it again with retries and a boundary, and an
 * unhandled rejection out here would be reported as a crash that nothing
 * actually depends on.
 */
export function warmUiVersion(
  pathname: string,
  hasCachedUser: boolean = readCachedUser() !== null
): Promise<unknown> | null {
  if (!hasCachedUser && !isAuthCallback(pathname)) return null;
  return LOADERS[activeUiVersion(pathname)]().catch(() => undefined);
}

/**
 * The one path where the hint is absent and the answer is still yes (SC-164).
 *
 * A reader only reaches `/auth/callback` by following a link the backend has
 * already verified — it is the redirect target of `magic-link/verify`, which
 * mints the session cookie before issuing it. So the question the hint stands
 * in for is not merely likely here, it is settled, and a first-time visitor
 * never arrives on this path at all, so the byte cost the gate exists to
 * prevent is not being paid by anybody.
 *
 * That matters because this is exactly the reader the hint fails. WebKit
 * clears script-writable storage after seven days without interaction, which
 * takes the last-user hint with it — and a returning reader past seven days is
 * who clicks a magic link (SC-130). The gate was refusing to warm on the one
 * landing where warming is most valuable and least speculative.
 *
 * The stored UI-generation preference lives in the same storage, so a device
 * that has lost the hint has lost the preference too and `activeUiVersion`
 * resolves to the default — the generation that device is about to be shown.
 */
function isAuthCallback(pathname: string): boolean {
  return pathname === '/auth/callback' || pathname === '/auth/callback/';
}

/**
 * A map of one-line loaders, and the shape is load-bearing — do not fold it
 * back into a conditional.
 *
 * Vite rewrites every `import()` into `__vitePreload(factory, deps)`, where
 * `deps` is the chunk list it computed statically. Write the choice as
 * `v === 'v2' ? import(a) : import(b)` and the *whole conditional* becomes one
 * `__vitePreload` call carrying **one** deps array — v3's — so warming v2 also
 * fetches the v3 chunk and a classic-UI reader downloads both generations.
 * That is the split undone for precisely the readers it was meant to leave
 * alone.
 *
 * `if (v === 'v2') return import(a); return import(b);` does not help either:
 * esbuild's TypeScript transform collapses it back into a ternary before Vite's
 * import analysis ever sees it — same emitted output, byte for byte identical
 * chunk hash. Two `import()` calls in two separate function bodies is what
 * survives, because there is no expression left to merge.
 *
 * None of this is visible in the source, in type-check, or in any test. It was
 * found by reading the request list off a real browser on `/v2`, and that is
 * the only place it shows.
 */
const LOADERS: Record<UiVersion, () => Promise<unknown>> = {
  v2: () => import('@/v2/V2App'),
  v3: () => import('@/v3/V3App'),
};
