import { describe, expect, test } from 'bun:test';
import { directionOf, MIRROR_IN_RTL } from '@scani/ui/lib/direction';

/**
 * `useDirection` itself is not testable here: bun's frontend tests render
 * through `react-dom/server`, which takes the server snapshot and never
 * subscribes, and there is no document for a `MutationObserver` to watch. What
 * it decides FROM is testable, and it is the part with a wrong answer available
 * — `dir` is a free-form attribute and an unset one reads as `''`, not `'ltr'`.
 *
 * The rendered consequence is the RTL visual baseline (`home-phone-rtl.png`):
 * the y-axis gutter is on the reading-start edge there or the pair is red.
 */
describe('directionOf', () => {
  test('only "rtl" is rtl; an unset attribute is the empty string, not "ltr"', () => {
    expect(directionOf('rtl')).toBe('rtl');
    expect(directionOf('RTL')).toBe('rtl');
    expect(directionOf('')).toBe('ltr');
    expect(directionOf('ltr')).toBe('ltr');
    expect(directionOf('auto')).toBe('ltr');
    expect(directionOf(null)).toBe('ltr');
    expect(directionOf(undefined)).toBe('ltr');
  });

  test('the CSS half is unchanged — a glyph still mirrors through the class', () => {
    expect(MIRROR_IN_RTL).toBe('rtl:-scale-x-100');
  });
});
