import { readCachedUser } from '@/lib/session-cache';

/**
 * Start fetching the interface a returning reader is about to be shown, before
 * anything asks for it.
 *
 * Splitting the interface out of the shell (SC-132 #2) moved 27% of the bundle
 * behind a second request — and measured **no improvement at all** for a
 * signed-in reader, because of *when* that request fires rather than how big it
 * is. It only renders below `ProtectedRoute`, which shows a spinner until the
 * session probe answers, so the chunk was not even requested until an API round
 * trip had completed. Bytes saved, an equal wait added, nothing gained: exactly
 * the "moves bytes without improving time-to-interactive" outcome the split was
 * required to avoid.
 *
 * Calling this from `main.tsx` moves the request to module-eval time, so it
 * overlaps the session probe instead of queueing behind it.
 *
 * **It is gated on the device having seen a session before** (`readCachedUser`,
 * the SC-78 hint) and that gate is the whole design. A first-time visitor gets
 * the sign-in form and never renders the interface at all, so warming it would
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
 *
 * **It used to choose between two chunks, and the shape of that choice was
 * load-bearing** (SC-423 removed the second). Vite rewrites every `import()`
 * into `__vitePreload(factory, deps)` with a statically computed `deps`, so a
 * conditional whose branches are both `import()` collapses into one call
 * carrying one dependency list — warming either generation fetched both. Two
 * `import()` calls in two separate function bodies was the only shape that
 * survived, because `if (…) return import(a); return import(b);` is folded back
 * into a ternary by esbuild before Vite's import analysis sees it. None of it
 * was visible in the source, in type-check, or in any test; it was found by
 * reading the request list off a real browser. Worth keeping written down: the
 * trap is a property of Vite, not of the tree that is gone, and it comes back
 * the moment a second `import()` is put behind a condition here.
 */
export function warmInterface(
  pathname: string,
  hasCachedUser: boolean = readCachedUser() !== null
): Promise<unknown> | null {
  if (!hasCachedUser && !isAuthCallback(pathname)) return null;
  return import('@/v3/V3App').catch(() => undefined);
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
 * who clicks a magic link (SC-130).
 */
function isAuthCallback(pathname: string): boolean {
  return pathname === '/auth/callback' || pathname === '/auth/callback/';
}
