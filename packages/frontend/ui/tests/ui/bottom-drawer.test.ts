import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

/**
 * Two invariants about getting *out* of a bottom drawer, both checked in the
 * source because the thing that breaks them is a portal: Radix's `Portal`
 * renders null under `renderToStaticMarkup`, so there is no markup to assert
 * on and no DOM environment in this repo to mount it in.
 *
 * Both failed together on an installed PWA (SC-39). The sheet was `h-dvh`, so
 * at its tallest snap point its top edge — and the grab handle sitting on it —
 * landed under `env(safe-area-inset-top)`, behind the status bar: invisible
 * and untappable. At that same height the sheet covers the viewport, so there
 * is no overlay left to tap either, and a phone has no Escape key. An open
 * menu with all three exits gone is an unusable app.
 */
const SOURCE = await Bun.file(join(import.meta.dir, '../../src/ui/bottom-drawer.tsx')).text();

/** The height the content element is given. */
const HEIGHT = /const DRAWER_HEIGHT =\s*\n?\s*'([^']*)'/.exec(SOURCE)?.[1] ?? '';
/** The static class list on the content element — everything before `cn`'s
 *  second argument, which is the caller's own `className`. */
const CONTENT_CLASSES = /'(fixed inset-x-0 bottom-0[^']*)'/.exec(SOURCE)?.[1] ?? '';

describe('bottom drawer — the ways out', () => {
  test('the sheet stops below the top safe-area inset', () => {
    expect(HEIGHT).toContain('env(safe-area-inset-top');
  });

  test('the banner offset and the inset are not subtracted twice', () => {
    // Top banners already pad themselves by the inset, so when one is up its
    // measured height subsumes it. `max()` is what keeps a drawer opened under
    // a banner from losing a second inset's worth of height for nothing.
    expect(HEIGHT).toContain('max(var(--scani-banner-offset, 0px), env(safe-area-inset-top, 0px))');
  });

  test('the height is inline, so a caller className cannot restore h-dvh', () => {
    // The three consumers each used to pass their own `h-[calc(100dvh-…)]`.
    // A class would let that come back silently; an inline style means a
    // caller has to say `style={{ height }}` out loud to override it.
    expect(CONTENT_CLASSES).not.toContain('h-dvh');
    expect(CONTENT_CLASSES).not.toMatch(/\bh-/);
    expect(SOURCE).toContain('height: DRAWER_HEIGHT,');
  });

  test('the close button is real, not screen-reader-only', () => {
    const close = /<DrawerPrimitive\.Close[\s\S]*?>/.exec(SOURCE)?.[0] ?? '';
    expect(close).toContain('aria-label={closeLabel}');
    expect(close).not.toContain('sr-only');
    expect(close).not.toContain('tabIndex={-1}');
  });

  test('there is exactly one Close, so the drag and the tap share it', () => {
    // `closeRef.current?.click()` is how a downward flick dismisses. Two
    // Closes would mean the visible one and the gesture's one could drift.
    expect(SOURCE.match(/<DrawerPrimitive\.Close/g)).toHaveLength(1);
    expect(SOURCE).toContain('ref={closeRef}');
  });

  test('the drawer owns the close, so its slots contribute none', () => {
    // The count above is the drawer's own promise. The other half of the
    // promise is that a consumer does not have to add one — and when
    // `BottomDrawerContent` gained this close in the SC-39 safe-area fix, the
    // v3 peek sheet's header kept drawing its own, so every phone peek showed
    // two × icons (SC-53). Neither header nor body may grow chrome of its own:
    // whatever the caller puts inside them is the caller's content, and the
    // way out is the drawer's.
    const slots = /const BottomDrawer(Header|Body) = [\s\S]*?;\n/g;
    for (const [slot] of SOURCE.matchAll(slots)) {
      expect(slot).not.toContain('Close');
      expect(slot).not.toContain('<X');
    }
    expect(SOURCE.match(/<X /g)).toHaveLength(1);
  });

  test('the close button carries a full tap target', () => {
    const close = /<DrawerPrimitive\.Close[\s\S]*?>/.exec(SOURCE)?.[0] ?? '';
    expect(close).toContain("minHeight: 'var(--tap-target, 2.75rem)'");
    expect(close).toContain("minWidth: 'var(--tap-target, 2.75rem)'");
  });

  test('Escape and the overlay are left to Radix unless the caller opts out', () => {
    // Radix Dialog closes on Escape and on pointer-down outside the content.
    // A drawer may only take those away by being told to — `dismissible` is
    // the single switch, and the ternaries are what keep the default drawer
    // on Radix's behaviour rather than on ours.
    expect(SOURCE).toContain('onEscapeKeyDown={dismissible ? undefined : preventDismissal}');
    expect(SOURCE).toContain('onInteractOutside={dismissible ? undefined : preventDismissal}');
    expect(SOURCE).toContain('dismissible = true');
  });

  test('a non-dismissible drawer loses the gesture too, not just the controls', () => {
    // The close button and the Radix handlers cover three of the four exits.
    // The fourth is a downward flick, which on a phone is the *first* one a
    // reader reaches for — and it resolves in `resolveRelease`, so the flag
    // has to reach there (SC-76).
    expect(SOURCE).toContain(
      'resolveRelease(dragPosition, state.velocity, points, { dismissible })'
    );
  });

  test('the close button is absent when the drawer is not dismissible, not disabled', () => {
    // A × that renders and does nothing reads as a broken app.
    expect(SOURCE).toContain('{dismissible ? (');
  });
});
