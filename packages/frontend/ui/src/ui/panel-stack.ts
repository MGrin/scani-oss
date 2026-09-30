import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Side panels opened over side panels, laid out beside each other (SC-1435).
 *
 * Each right-hand `SheetContent` joins this stack while it is open. A panel
 * opened over another used to land on top of it with a second backdrop, so the
 * page went from dimmed to black and the first panel was hidden under the
 * second. Now the newest panel takes the edge and every panel under it slides
 * over by the width of the panels above it, so the two read side by side.
 *
 * - **Two panels are visible at most.** A third slides in at the edge, the
 *   second moves beside it, and the first slides out of view until the reader
 *   comes back down to it.
 * - **Only the bottom panel dims the page.** The others draw a transparent
 *   overlay, which still takes a click — a click anywhere outside the top
 *   panel, the panel under it included, closes the top one and slides the
 *   one under it back to the edge.
 *
 * The layout is desktop-only by CSS (`lg:` on every class that reads this
 * store), so a sheet that renders below 1024px is untouched — v3 uses bottom
 * drawers there, and v2's sheets keep their own behaviour.
 */

interface Panel {
  id: number;
  width: number;
}

export const VISIBLE_PANELS = 2;

let panels: Panel[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return panels;
}

export function openPanel(width: number): number {
  const id = nextId++;
  panels = [...panels, { id, width }];
  emit();
  return id;
}

function resizePanel(id: number, width: number) {
  if (!panels.some((panel) => panel.id === id && panel.width !== width)) return;
  panels = panels.map((panel) => (panel.id === id ? { ...panel, width } : panel));
  emit();
}

export function closePanel(id: number) {
  if (!panels.some((panel) => panel.id === id)) return;
  panels = panels.filter((panel) => panel.id !== id);
  emit();
}

export interface PanelPlace {
  /** 0 is the panel opened first. */
  depth: number;
  /** How far toward the start edge it sits: the widths of every panel above it. */
  shift: number;
  /** Below the two visible panels — slid out of view. */
  hidden: boolean;
}

/** Where a panel sits in a stack. Pure, so the layout is testable without a DOM. */
export function placeOf(stack: readonly Panel[], id: number): PanelPlace | null {
  const depth = stack.findIndex((panel) => panel.id === id);
  if (depth < 0) return null;
  const above = stack.slice(depth + 1);
  return {
    depth,
    shift: above.reduce((sum, panel) => sum + panel.width, 0),
    hidden: stack.length - depth > VISIBLE_PANELS,
  };
}

/**
 * Join the stack while the element is open. Leaves as soon as Radix marks it
 * closed, not when it unmounts after the exit animation, so the panel under it
 * slides back at the same moment this one slides out.
 */
export function usePanelStack(enabled: boolean) {
  const stack = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [id, setId] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled || !node) return;
    let current: number | null = null;
    const join = () => {
      if (current === null) {
        current = openPanel(node.offsetWidth);
        setId(current);
      }
    };
    const leave = () => {
      if (current !== null) closePanel(current);
      current = null;
      setId(null);
    };
    const sync = () => (node.dataset.state === 'closed' ? leave() : join());
    sync();
    const states = new MutationObserver(sync);
    states.observe(node, { attributes: true, attributeFilter: ['data-state'] });
    const sizes =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (current !== null) resizePanel(current, node.offsetWidth);
          });
    sizes?.observe(node);
    return () => {
      states.disconnect();
      sizes?.disconnect();
      leave();
    };
  }, [enabled, node]);

  const ref = useCallback((element: HTMLElement | null) => setNode(element), []);
  return { ref, place: id === null ? null : placeOf(stack, id) };
}
