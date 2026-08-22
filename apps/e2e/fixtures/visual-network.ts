import type { Page } from '@playwright/test';

/**
 * What the visual gate is allowed to fetch, and what it renders instead
 * (SC-524).
 *
 * The gate asserts at `maxDiffPixels: 0` against a committed PNG. That is only
 * a coherent thing to do if every byte the page draws from is a byte this
 * repository controls — and until this module existed, six rows across two
 * baselines drew their institution mark from
 * `https://www.google.com/s2/favicons`, fetched over the public internet while
 * the screenshot was being taken (`getFaviconUrl`, in
 * `apps/frontend/app/src/lib/icons.ts`).
 *
 * **The mechanism, forced rather than guessed.** That URL 301s to a *rotating*
 * `t{0..3}.gstatic.com` shard — five consecutive runs went t3, t1, t2, t3, t1 —
 * so a mark has to finish DNS and TLS to one host, a redirect, DNS and TLS to
 * another, and the image itself, all inside the settle window. When it does
 * not, the mark's track photographs empty. Driving the two failure states
 * deliberately, with `page.route` on the external URL only:
 *
 * | forced state                              | pixels different |
 * |-------------------------------------------|------------------|
 * | fetch aborted -> `FaviconImg` letter tile | 537, 537         |
 * | fetch delayed past the capture            | 591              |
 * | *natural* failing run, no probe at all    | **591**          |
 *
 * So the observed flake is the second row and not the first, and the two are
 * distinguishable — which is worth knowing, because "the icon broke" covers
 * both and they have different fixes. Six runs of an unchanged tree gave one
 * fail and five passes.
 *
 * **`toHaveScreenshot` makes this worse rather than better.** It retries until
 * two captures agree, and two consecutive captures of a mark that has not
 * arrived agree perfectly — it logged "captured a stable screenshot" over the
 * failing one. A stable wrong answer reads exactly like a stable right one,
 * which is the same shape as the spinner SC-473 committed as a baseline.
 *
 * **The same retry answers a different question correctly, and it is worth
 * reading for that.** All three of `toHaveScreenshot`'s attempts reported the
 * *identical* count once the mark was pinned — 591/591/591 on
 * `holdings-desktop`, 978/978/978 on `holdings-phone`. Attempts that agree are
 * worthless as evidence that the page was ready and are good evidence that the
 * render is deterministic. The behaviour that manufactured false confidence
 * over an unarrived mark is the behaviour that confirms fixed bytes produce
 * fixed pixels; which of the two you are reading depends entirely on whether
 * anything in the picture could still be in flight, and after this module
 * nothing can be.
 *
 * **What is NOT the mechanism, recorded because it is true and misleading.**
 * That endpoint is also not byte-stable: ten requests for `?domain=chase.com`
 * over ten seconds returned a 1568-byte JPEG seven times and a 625-byte
 * palettised PNG three times, and a browser-shaped `Accept` header changes
 * nothing. Downscaled to the 20 CSS pixels a row draws a mark at, those two
 * differ in 293 of 400 pixels. But the seeded institution is
 * `www.jpmorganchase.com`, whose bytes did not move across thirty
 * observations, so encoding roulette is a real hazard of depending on this
 * endpoint and is not what turned these baselines red. It belongs to SC-208.
 *
 * **Why the seal is the whole off-host surface, not that one URL.** A gate that
 * pins the one external asset it currently knows about is non-deterministic
 * again the day somebody adds a second, silently — which is the failure this
 * ticket is about. Every request to a host that is not loopback is intercepted
 * here: the institution mark is served from `PINNED_ICON`, and anything else is
 * aborted *and recorded*, so `assertPinnedBytes` in `visual/v3-screens.spec.ts`
 * fails the run naming the URL rather than letting it become tomorrow's
 * intermittent diff.
 *
 * That also makes drift self-reporting. If `getFaviconUrl` is ever pointed at a
 * different host, its requests stop matching `isInstitutionMark` and start
 * arriving in `escaped` — a red run that names the new URL, not a quiet return
 * to the old behaviour.
 *
 * **Matching on the hostname is load-bearing, not stylistic.** A pattern like
 * `/favicon/i` also matches the app's own module URL under the dev server —
 * `http://localhost:<port>/@fs/…/components/FaviconImg.tsx` — so a route keyed
 * on the word intercepts the component instead of its image, and the shell
 * never mounts. Measured while building this.
 */

/**
 * SC-208 MOVED THE URL, AND THAT IS WHY THE PIN IS STILL HERE.
 *
 * The mark now comes from our own api — `GET /institution-icons/<id>`, which
 * resolves the institution's icon server-side and caches it in R2. So the
 * request the browser makes is to LOOPBACK under this gate, and the paragraphs
 * above describe a dependency the product no longer has.
 *
 * The dependency the *gate* has did not go away, it moved one process across.
 * An unpinned run would have the api reach `jpmorganchase.com` while the
 * screenshot was being taken: the same network, the same settle window, the
 * same intermittent empty track — and now with a cold-versus-warm R2 cache
 * deciding whether it is fast or slow, which is worse than what SC-524 fixed
 * rather than better.
 *
 * So `isInstitutionMark` matches on the PATH and the route predicate has to
 * take loopback traffic too. That is the one thing to understand before
 * editing this file: the seal is `not loopback` **or** `is an institution
 * mark`, and dropping the second half puts the gate back on the public
 * internet through a hop that does not appear in `escaped`, because nothing
 * outside loopback was ever requested. It would look exactly like a clean run.
 */

/** Hosts served by `exposeNetwork: '<loopback>'` — this checkout's own stack. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * The bytes every institution mark renders from under this gate: an opaque
 * 64x64 magenta square.
 *
 * Solid on purpose. The baseline cannot assert anything about what a bank's
 * logo looks like — those pixels were never ours and the endpoint will not
 * hold them still — so what it is here to hold is that a decoded image of the
 * right size occupies the row's leading track. A structured glyph would add
 * bytes to review and assert nothing more.
 *
 * Magenta on purpose too, and it is the louder half of the decision: a
 * reviewer opening `holdings-desktop.png` must not be able to mistake this for
 * a real favicon and reason about it as product design.
 *
 * Inline rather than a committed file so the thing under review is a
 * description of an image instead of an opaque binary. Reproduce it with any
 * PNG encoder: 64x64, colour type 2, every pixel `#FF00FF`.
 */
const PINNED_ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATElEQVR42u3PMQkAAAwDsPo33Uno' +
    'PQjEQNL0tQgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgILAdB' +
    'p+HSRtACMAAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * The `<img src>` an institution mark asks for — see `institutionIconUrl` in
 * `apps/frontend/app/src/lib/icons.ts`.
 *
 * Matched on the PATH with no host condition, because SC-208 put this route on
 * our own api: in this gate that is loopback, in production it is
 * `api.scani.xyz`, and in the published image it is same-origin behind nginx.
 * A host condition would be right for exactly one of those three.
 *
 * The path is specific enough to be safe on loopback — it is one route, and it
 * is the only one under this prefix — and the drift-reporting property SC-524
 * wanted survives: point `institutionIconUrl` somewhere else and these
 * requests stop matching. Off-host they land in `escaped` and go red by name;
 * on-loopback they simply stop being pinned, which is why
 * `assertPinnedBytes` also insists a screen declaring `institutionMark`
 * actually drew one.
 */
export const INSTITUTION_ICON_PATH = '/institution-icons/';

function isInstitutionMark(url: URL): boolean {
  // `includes`, not `startsWith`, and the docstring above is why. The published
  // image builds with `VITE_API_URL=/api` and nginx reverse-proxies, so there
  // the mark is requested at `/api/institution-icons/<id>`. `startsWith` covers
  // two of the three deployments the comment claims and quietly misses the
  // third — a docstring writing a cheque the predicate does not honour.
  return url.pathname.includes(INSTITUTION_ICON_PATH);
}

export interface PinnedNetwork {
  /** Institution marks served from `PINNED_ICON`. */
  icons: number;
  /** Off-host URLs nothing pinned. Each is a baseline this gate cannot
   *  reproduce on another machine, another day or another network. */
  escaped: string[];
}

/**
 * Seals `page` off the public internet for the rest of its life, and returns
 * the record of what it asked for.
 *
 * Install before `goto`: a route added afterwards does not apply to requests
 * the navigation has already started.
 */
export async function pinExternalNetwork(page: Page): Promise<PinnedNetwork> {
  const record: PinnedNetwork = { icons: 0, escaped: [] };
  await page.route(
    // Not `!LOOPBACK.has(...)` alone: since SC-208 the institution mark IS a
    // loopback request, and letting it through means the api fetches the real
    // internet mid-capture with nothing recorded in `escaped`.
    (url) => !LOOPBACK.has(url.hostname) || isInstitutionMark(url),
    async (route, request) => {
      const url = new URL(request.url());
      if (isInstitutionMark(url)) {
        record.icons += 1;
        await route.fulfill({ status: 200, contentType: 'image/png', body: PINNED_ICON });
        return;
      }
      record.escaped.push(request.url());
      await route.abort('blockedbyclient');
    }
  );
  return record;
}
