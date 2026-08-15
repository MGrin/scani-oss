import { describe, expect, it } from 'bun:test';
import {
  hasStrandedDocumentScroll,
  isKeyboardObscuring,
  resolveFieldScrollDelta,
  resolveShellHeight,
} from '../../src/lib/viewport';

/**
 * The numbers below are samples from iOS 26.5 on an iPhone 17 Pro Simulator,
 * taken in an installed PWA (`display-mode: standalone`) and in a Safari tab.
 * They are the reason the code measures what it measures, so they are what
 * the tests assert on.
 */

describe('isKeyboardObscuring', () => {
  it('sees the keyboard in an installed PWA, where innerHeight lies', () => {
    // Standalone, keyboard up: innerHeight had already shrunk 812 → 800, so
    // `innerHeight - (offsetTop + height)` gave 379 by luck here but −68 in
    // the case that stranded the bar. clientHeight stays 812 either way.
    expect(isKeyboardObscuring({ layoutHeight: 812, visualHeight: 409 })).toBe(true);
  });

  it('sees the keyboard in a browser tab', () => {
    expect(isKeyboardObscuring({ layoutHeight: 714, visualHeight: 377 })).toBe(true);
  });

  it('is quiet at rest', () => {
    expect(isKeyboardObscuring({ layoutHeight: 812, visualHeight: 812 })).toBe(false);
    expect(isKeyboardObscuring({ layoutHeight: 714, visualHeight: 714 })).toBe(false);
  });

  it('ignores URL-bar collapse jitter, which the 50px floor exists for', () => {
    expect(isKeyboardObscuring({ layoutHeight: 812, visualHeight: 783 })).toBe(false);
  });

  it('reads the accessory bar alone as obscuring only past the floor', () => {
    // 68px accessory bar, no keyboard — measured standalone.
    expect(isKeyboardObscuring({ layoutHeight: 812, visualHeight: 744 })).toBe(true);
  });
});

describe('hasStrandedDocumentScroll', () => {
  const shell = { layoutHeight: 812, documentScrollHeight: 812 };

  it('flags the measured artifact: scrollY 68 on a document with no range', () => {
    expect(hasStrandedDocumentScroll({ ...shell, scrollY: 68, visualOffsetTop: 68 })).toBe(true);
  });

  it('flags an offset carried by the visual viewport alone', () => {
    expect(hasStrandedDocumentScroll({ ...shell, scrollY: 0, visualOffsetTop: 68 })).toBe(true);
  });

  it('leaves a document that genuinely scrolls alone', () => {
    expect(
      hasStrandedDocumentScroll({
        layoutHeight: 812,
        documentScrollHeight: 4000,
        scrollY: 68,
        visualOffsetTop: 0,
      })
    ).toBe(false);
  });

  it('does nothing when the page is already at the top', () => {
    expect(hasStrandedDocumentScroll({ ...shell, scrollY: 0, visualOffsetTop: 0 })).toBe(false);
  });

  it('absorbs a fractional layout height', () => {
    expect(
      hasStrandedDocumentScroll({
        layoutHeight: 812,
        documentScrollHeight: 812.5,
        scrollY: 68,
        visualOffsetTop: 68,
      })
    ).toBe(true);
  });
});

describe('resolveShellHeight', () => {
  // iPhone 17e / iOS 26.5, installed to the home screen, focused on the Notes
  // field at the bottom of the payment form (SC-65).
  it('gives the shell the visible band while the keyboard is up', () => {
    expect(resolveShellHeight({ layoutHeight: 797, visualHeight: 421 })).toBe(421);
  });

  it('leaves the shell alone at rest, so `100dvh` stands', () => {
    expect(resolveShellHeight({ layoutHeight: 797, visualHeight: 797 })).toBeNull();
  });

  it('ignores URL-bar jitter for the same reason the pin does', () => {
    expect(resolveShellHeight({ layoutHeight: 812, visualHeight: 783 })).toBeNull();
  });

  it('measures against the layout viewport, which is what standalone keeps honest', () => {
    // `innerHeight` read 466 here — between the two — so a shell sized from it
    // would have run 45px past the keyboard.
    expect(resolveShellHeight({ layoutHeight: 797, visualHeight: 421 })).not.toBe(466);
  });

  it('rounds, because a fractional height leaves a hairline of canvas', () => {
    expect(resolveShellHeight({ layoutHeight: 797, visualHeight: 420.6 })).toBe(421);
  });
});

describe('resolveFieldScrollDelta', () => {
  // Keyboard up in the PWA: the visible band is 409px tall at the top.
  const keyboardUp = { visualHeight: 409, visualOffsetTop: 0 };

  it('leaves a field that already sits inside the band', () => {
    expect(resolveFieldScrollDelta({ top: 100, bottom: 144 }, keyboardUp)).toBe(0);
  });

  it('lifts a field hidden behind the keyboard', () => {
    // Bottom at 500 against a band ending at 409 − 16 margin = 393.
    expect(resolveFieldScrollDelta({ top: 456, bottom: 500 }, keyboardUp)).toBe(107);
  });

  it('lowers a field pushed above the band', () => {
    expect(resolveFieldScrollDelta({ top: -20, bottom: 24 }, keyboardUp)).toBe(-36);
  });

  it('measures against the visual viewport offset, not the layout viewport', () => {
    // The measured stranded state: the visible band starts 68px down.
    const offset = { visualHeight: 744, visualOffsetTop: 68 };
    expect(resolveFieldScrollDelta({ top: 40, bottom: 84 }, offset)).toBe(-44);
  });

  it('prefers the bottom edge for a field taller than the band', () => {
    expect(resolveFieldScrollDelta({ top: 0, bottom: 600 }, keyboardUp)).toBe(207);
  });

  it('honours a caller-supplied margin', () => {
    expect(resolveFieldScrollDelta({ top: 456, bottom: 500 }, keyboardUp, 0)).toBe(91);
  });
});
