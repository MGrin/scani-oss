import { describe, expect, test } from 'bun:test';
import { subscribeToHide } from '@scani/ui/hooks/useDismissOnHide';

/**
 * SC-124. A destructive confirm must not survive a background cycle — the
 * hazard is not a stray tap (SC-63/SC-73 already moved the affirmative away
 * from the trigger for that) but a deliberate tap made twenty minutes later in
 * a context the reader has forgotten.
 *
 * The hook itself is one `useEffect`; what is worth pinning is the wiring it
 * installs, so that is what `subscribeToHide` exposes. Three things could
 * regress silently and each costs the fix: dropping one of the two events —
 * iOS routinely delivers only `pagehide` — firing on the way *back* into the
 * app, and leaking the listeners so a closed confirm keeps answering.
 */

interface FakeTarget {
  listeners: Map<string, Set<() => void>>;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  emit: (type: string) => void;
  count: (type: string) => number;
}

function fakeTarget(): FakeTarget {
  const listeners = new Map<string, Set<() => void>>();
  return {
    listeners,
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    count(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function harness(visibilityState = 'visible') {
  const doc = { ...fakeTarget(), visibilityState };
  const win = fakeTarget();
  let dismissed = 0;
  const unsubscribe = subscribeToHide(
    () => {
      dismissed += 1;
    },
    doc,
    win
  );
  return {
    doc,
    win,
    unsubscribe,
    dismissed: () => dismissed,
  };
}

describe('subscribeToHide', () => {
  test('closes the confirm when the app is backgrounded', () => {
    const h = harness();
    h.doc.visibilityState = 'hidden';
    h.doc.emit('visibilitychange');
    expect(h.dismissed()).toBe(1);
  });

  /** The event fires in both directions. Only one of them is a hide. */
  test('leaves it standing when the app comes back', () => {
    const h = harness();
    h.doc.visibilityState = 'visible';
    h.doc.emit('visibilitychange');
    expect(h.dismissed()).toBe(0);
  });

  /** On iOS this is often the only one of the two that arrives. */
  test('closes it on pagehide, with no visibility change at all', () => {
    const h = harness();
    h.win.emit('pagehide');
    expect(h.dismissed()).toBe(1);
  });

  test('stops listening once the confirm is gone', () => {
    const h = harness();
    h.unsubscribe();
    expect(h.doc.count('visibilitychange')).toBe(0);
    expect(h.win.count('pagehide')).toBe(0);

    h.doc.visibilityState = 'hidden';
    h.doc.emit('visibilitychange');
    h.win.emit('pagehide');
    expect(h.dismissed()).toBe(0);
  });
});
