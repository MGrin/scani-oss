import { describe, expect, test } from 'bun:test';
import { closePanel, openPanel, placeOf, VISIBLE_PANELS } from '../../src/ui/panel-stack';

/** SC-1435: a panel over a panel sits beside it; at most two are visible. */
describe('panel stack', () => {
  const stack = [
    { id: 1, width: 448 },
    { id: 2, width: 448 },
    { id: 3, width: 400 },
  ];

  test('the top panel keeps the edge; each one under it moves by the widths above', () => {
    expect(placeOf(stack.slice(0, 1), 1)).toEqual({ depth: 0, shift: 0, hidden: false });
    expect(placeOf(stack.slice(0, 2), 1)).toEqual({ depth: 0, shift: 448, hidden: false });
    expect(placeOf(stack.slice(0, 2), 2)).toEqual({ depth: 1, shift: 0, hidden: false });
  });

  test('a third panel slides the first out of view', () => {
    expect(VISIBLE_PANELS).toBe(2);
    expect(placeOf(stack, 1)).toEqual({ depth: 0, shift: 848, hidden: true });
    expect(placeOf(stack, 2)).toEqual({ depth: 1, shift: 400, hidden: false });
    expect(placeOf(stack, 3)).toEqual({ depth: 2, shift: 0, hidden: false });
  });

  test('closing the top panel returns the one under it to the edge', () => {
    const first = openPanel(448);
    const second = openPanel(448);
    closePanel(second);
    // Control: a panel no longer in the stack has no place.
    expect(placeOf([{ id: first, width: 448 }], second)).toBeNull();
    expect(placeOf([{ id: first, width: 448 }], first)).toEqual({
      depth: 0,
      shift: 0,
      hidden: false,
    });
    closePanel(first);
  });
});
