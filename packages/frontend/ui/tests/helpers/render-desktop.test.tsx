import { describe, expect, test } from 'bun:test';
import { useIsDesktop } from '@scani/ui/v3/hooks/useMediaQuery';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderDesktop } from './render-desktop';

/** Reads the hook, so the stub is exercised, and says which branch it took. */
function Surface() {
  return <p>{useIsDesktop() ? 'desktop' : 'phone'}</p>;
}

/** Reads nothing. `renderDesktop` must refuse this rather than hand back the
 *  phone surface for a caller to make desktop assertions on. */
function Inert() {
  return <p>inert</p>;
}

function Throws(): never {
  throw new Error('render blew up');
}

function hasWindow(): boolean {
  return 'window' in globalThis;
}

describe('renderDesktop — the stub takes', () => {
  test('the desktop branch renders, and the same component renders the phone branch without it', () => {
    // Both arms, because "it said desktop" is satisfied by a component that
    // says desktop unconditionally.
    expect(renderDesktop(<Surface />)).toInclude('desktop');
    expect(renderToStaticMarkup(<Surface />)).toInclude('phone');
  });
});

describe('renderDesktop — nothing is left behind', () => {
  // `bun test` runs every file in one process, so a leaked `window` changes
  // what every LATER file renders, in code its author never touched (SC-448).
  test('no window survives a successful render', () => {
    expect(hasWindow()).toBe(false);
    renderDesktop(<Surface />);
    expect(hasWindow()).toBe(false);
  });

  test('no window survives a render that throws — this is what the `finally` is for', () => {
    expect(hasWindow()).toBe(false);
    expect(() => renderDesktop(<Throws />)).toThrow('render blew up');
    expect(hasWindow()).toBe(false);
  });

  test('a window that was already there is put back exactly as it was', () => {
    const target = globalThis as { window?: unknown };
    const sentinel = { marker: 'pre-existing' };
    target.window = sentinel;
    try {
      renderDesktop(<Surface />);
      expect(target.window).toBe(sentinel);
    } finally {
      delete target.window;
    }
    expect(hasWindow()).toBe(false);
  });
});

/**
 * The built-in control. Without it, a stub that stops taking renders the phone
 * surface and every desktop assertion written against it passes for the wrong
 * branch — which is SC-797's own defect, reintroduced inside its fix.
 *
 * It answers a different question from the per-test marker control: this one
 * says the hook read the stub, not that the desktop branch produced markup.
 * Six of the seven `useIsDesktop` consumers return a Radix portal on BOTH
 * branches and emit zero bytes here with the stub read either way, so a caller
 * still owes a marker only its desktop branch can render.
 */
describe('renderDesktop — it refuses a render that never read the stub', () => {
  test('a component that ignores the viewport is a refusal, not a pass', () => {
    expect(() => renderDesktop(<Inert />)).toThrow('nothing read window.matchMedia');
  });

  test('a component that reads it is not refused — the arm that makes the refusal a measurement', () => {
    expect(() => renderDesktop(<Surface />)).not.toThrow();
  });

  test('a refusal still restores the window', () => {
    expect(hasWindow()).toBe(false);
    expect(() => renderDesktop(<Inert />)).toThrow();
    expect(hasWindow()).toBe(false);
  });
});
