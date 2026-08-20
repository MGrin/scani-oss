import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import {
  runViewTransition,
  shouldTransitionRoute,
  supportsViewTransitions,
} from '../../../src/v3/lib/view-transition';

/**
 * The route-transition wrapper of §2.4 — thirty lines and no bundle, against
 * ~31KB gzipped for an animation library. What is worth checking is not the
 * animation (that is four CSS rules) but the two bail-outs, because a wrapper
 * that animates the wrong navigations is worse than no wrapper.
 */

describe('shouldTransitionRoute — which navigations are worth animating', () => {
  test('a move between destinations is', () => {
    expect(shouldTransitionRoute('/', '/payments')).toBe(true);
    expect(shouldTransitionRoute('/holdings', '/vendors')).toBe(true);
  });

  /** A peek sheet assigns the record a URL of its own (V3-11), so opening one
   *  is a navigation — but the screen behind it does not change. Cross-fading
   *  the list under a sheet that is sliding up is two animations disagreeing
   *  about what just happened. */
  test('opening or closing a peek sheet is not', () => {
    expect(shouldTransitionRoute('/payments', '/payments/occ_123')).toBe(false);
    expect(shouldTransitionRoute('/payments/occ_123', '/payments')).toBe(false);
  });

  test('a navigation to where you already are is not', () => {
    expect(shouldTransitionRoute('/payments', '/payments')).toBe(false);
  });

  /** Money's segments are separate nav destinations — the sidebar lists both —
   *  so moving between them is a screen change and reads as one. */
  test('Money’s segments are separate destinations', () => {
    expect(shouldTransitionRoute('/payments', '/payments/recurring')).toBe(true);
  });
});

describe('supportsViewTransitions', () => {
  test('is false wherever the API is missing, which is the whole fallback', () => {
    expect(supportsViewTransitions(undefined)).toBe(false);
    expect(supportsViewTransitions({})).toBe(false);
    expect(supportsViewTransitions({ startViewTransition: () => undefined })).toBe(true);
  });
});

describe('runViewTransition', () => {
  /** Bun's test environment has no `document`, which is exactly the shape of
   *  every browser without the API: the update still happens, unanimated. A
   *  navigation must never depend on the animation succeeding. */
  test('applies the update anyway when there is no view-transition API', () => {
    let applied = false;
    let flushed = false;
    const animated = runViewTransition(
      () => {
        applied = true;
      },
      (apply) => {
        flushed = true;
        apply();
      }
    );
    expect(animated).toBe(false);
    expect(applied).toBe(true);
    // `flushSync` is only correct inside a transition — forcing a synchronous
    // render on the plain path would cost a frame for nothing.
    expect(flushed).toBe(false);
  });
});
