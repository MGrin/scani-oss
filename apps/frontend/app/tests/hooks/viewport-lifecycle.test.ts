import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

/**
 * The keyboard dead band, as far as it can be pinned without a DOM.
 *
 * These are source assertions for the same reason as
 * `packages/frontend/ui/tests/ui/bottom-drawer.test.ts`: the repo has no DOM
 * test environment, and the defects here are about *which listeners exist*
 * and *how many copies of the geometry there are* — both of which the source
 * states plainly and both of which a refactor silently reverts. The numbers
 * behind them were measured on an iOS 26.5 simulator; the arithmetic they
 * feed is unit-tested in `tests/lib/viewport.test.ts`.
 */
const SRC = join(import.meta.dir, '../../src');
const read = (path: string) => Bun.file(join(SRC, path)).text();

const EFFECT = await read('hooks/useViewportEffect.ts');
const PIN = await read('hooks/useVisualViewportPin.ts');
const RECOVERY = await read('hooks/useViewportScrollRecovery.ts');
const MOBILE_NAV = await read('v2/layouts/MobileNav.tsx');
const TAB_BAR = await read('v3/layouts/V3TabBar.tsx');
const SHELL_PIN = await read('hooks/useVisualViewportShell.ts');
const FIELD = await read('hooks/useFocusedFieldVisibility.ts');
const V3_SHELL = await read('v3/layouts/V3Shell.tsx');

/** Every one of these files explains the wrong formula in prose next to the
 *  right one, so "the source does not mention X" has to mean the code. */
const code = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');

describe('coming back from the background re-reads the viewport', () => {
  // Measured, not assumed: across a background/foreground cycle the
  // visualViewport listeners fired once before the app was suspended and not
  // again when it returned eleven seconds later. Without these two, a page
  // that was backgrounded holding the keyboard's scroll offset keeps the dead
  // band for the rest of its life — which is why killing the PWA is the only
  // thing that clears it.
  test('the page lifecycle is listened to at all', () => {
    expect(EFFECT).toContain("window.addEventListener('pageshow'");
    expect(EFFECT).toContain("document.addEventListener('visibilitychange'");
  });

  test('a lifecycle event reads now rather than queuing a frame', () => {
    // A returning page has no frame-budget problem to solve, it has a stale
    // conclusion to replace. Scheduling a frame the platform has no reason to
    // produce is how the stale conclusion survives.
    const resync = /const resync = \(\) => \{[\s\S]*?\n {4}\};/.exec(EFFECT)?.[0] ?? '';
    expect(resync).toContain('cancelAnimationFrame');
    expect(resync).toContain('run()');
    expect(resync).not.toContain('requestAnimationFrame(');
  });

  test('every listener is removed again', () => {
    const added = EFFECT.match(/addEventListener\('([a-z]+)'/g) ?? [];
    const removed = EFFECT.match(/removeEventListener\('([a-z]+)'/g) ?? [];
    expect(added.length).toBeGreaterThan(0);
    expect(removed.map((r) => r.replace('remove', 'add')).sort()).toEqual(added.sort());
  });
});

describe('one pin, shared by both shells', () => {
  // v3 was corrected in V3-35 and v2 — the shell the user actually runs — was
  // left on `window.innerHeight`, so the bug he reported stayed live in the UI
  // he reported it from. Two copies is what let that happen.
  test('neither shell carries its own copy of the hook', () => {
    for (const source of [MOBILE_NAV, TAB_BAR]) {
      expect(source).toContain(
        "import { useVisualViewportPin } from '@/hooks/useVisualViewportPin'"
      );
      expect(source).not.toContain('function useVisualViewportPin');
    }
  });

  test('the keyboard is measured against the layout viewport', () => {
    // `innerHeight - (offsetTop + height)` reads +337 in a browser tab and
    // −68 in an installed PWA for the same keyboard, because standalone iOS
    // shrinks `innerHeight` in step with the visual viewport and the terms
    // cancel. `clientHeight` did not move in any sample.
    expect(code(PIN)).toContain('document.documentElement.clientHeight');
    expect(code(PIN)).not.toContain('window.innerHeight');
    expect(code(MOBILE_NAV)).not.toContain('window.innerHeight');
  });

  test('both viewport hooks share one scheduler', () => {
    for (const source of [PIN, RECOVERY]) {
      expect(code(source)).toContain('useViewportEffect');
      expect(code(source)).not.toContain('requestAnimationFrame');
      expect(code(source)).not.toContain('addEventListener');
    }
  });
});

describe('the shell is sized to the keyboard, not to the document (SC-65)', () => {
  test('the v3 shell mounts the sizing hook', () => {
    expect(V3_SHELL).toContain(
      "import { useVisualViewportShell } from '@/hooks/useVisualViewportShell'"
    );
    expect(code(V3_SHELL)).toContain('useVisualViewportShell(shellRef)');
  });

  test('v2 does not, and must not', () => {
    // Taking v2's scroll offset away without sizing its shell to the visible
    // band would put the field that offset was lifting back behind the
    // keyboard. The two halves are one fix and v2 has neither.
    expect(MOBILE_NAV).not.toContain('useVisualViewportShell');
  });

  test('it sizes and un-scrolls together, because either alone is worse', () => {
    expect(code(SHELL_PIN)).toContain('resolveShellHeight');
    expect(code(SHELL_PIN)).toContain('window.scrollTo(0, 0)');
    // Guarded: iOS answers the reset with a visual-viewport `scroll`, which
    // re-enters this callback.
    expect(code(SHELL_PIN)).toContain('window.scrollY !== 0');
  });

  test('at rest it hands the height back to the class rather than freezing one', () => {
    // A shell pinned to a number measured while the keyboard was up keeps that
    // number after it goes down, which is the dead band all over again.
    expect(code(SHELL_PIN)).toContain("shell.style.height = ''");
  });

  test('it shares the one scheduler, so it survives backgrounding too', () => {
    expect(code(SHELL_PIN)).toContain('useViewportEffect');
    expect(code(SHELL_PIN)).not.toContain('addEventListener');
  });

  test('the field being typed into is re-revealed when the app comes back', () => {
    // Measured: a page backgrounded with the keyboard up returns with its
    // scrollers restored — the focused field moved from 325..405 to 501..581,
    // i.e. behind the keyboard — and with no viewport event to notice it by.
    expect(FIELD).toContain("window.addEventListener('pageshow'");
    expect(FIELD).toContain("document.addEventListener('visibilitychange'");
  });

  test('every listener the field hook adds is removed again', () => {
    const added = FIELD.match(/addEventListener\('([a-z]+)'/g) ?? [];
    const removed = FIELD.match(/removeEventListener\('([a-z]+)'/g) ?? [];
    expect(added.length).toBeGreaterThan(0);
    expect(removed.map((r) => r.replace('remove', 'add')).sort()).toEqual(added.sort());
  });
});
