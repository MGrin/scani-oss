import { describe, expect, it } from 'bun:test';
import { hslTripleToRgb } from '../../src/design-tokens/hsl';

describe('hslTripleToRgb', () => {
  it('white / black / pure red', () => {
    expect(hslTripleToRgb('0 0% 100%')).toEqual({ r: 255, g: 255, b: 255 });
    expect(hslTripleToRgb('0 0% 0%')).toEqual({ r: 0, g: 0, b: 0 });
    expect(hslTripleToRgb('0 100% 50%')).toEqual({ r: 255, g: 0, b: 0 });
  });

  it('handles decimal lightness (foreground 3.9%)', () => {
    expect(hslTripleToRgb('0 0% 3.9%')).toEqual({ r: 10, g: 10, b: 10 });
  });

  it('handles a saturated hue (chart-1 light)', () => {
    const { r, g, b } = hslTripleToRgb('12 76% 61%');
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  it('throws on a malformed triple', () => {
    expect(() => hslTripleToRgb('not-a-triple')).toThrow();
  });
});
