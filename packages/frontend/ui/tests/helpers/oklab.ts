/**
 * OKLab ΔE over the `H S% L%` triplets the token layer stores.
 *
 * The `dataviz` skill measures every colour separation as Euclidean distance in
 * OKLab ×100, so this is the same metric its validator reports — which is what
 * lets a test here assert a claim the committed validator output made, rather
 * than restating it in a comment where it can rot.
 *
 * Deliberately *not* a CVD simulation. That needs the Machado–Oliveira–
 * Fernandes matrices and belongs to the skill's validator, which is run by hand
 * and whose output is committed at
 * `docs/implementation/2026-08-12_v3-chart-palette.md`. What lives here is the
 * unsimulated distance, which is enough to pin the one rule the runtime leans
 * on: a categorical slot must not be mistakable for a semantic token.
 */

import { type Hsl, parseHslTriplet } from './contrast';

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function hslToLinearRgb(color: Hsl | string): [number, number, number] {
  const { h, s, l } = typeof color === 'string' ? parseHslTriplet(color) : color;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  return [toLinear(r + m), toLinear(g + m), toLinear(b + m)];
}

/** Björn Ottosson's OKLab, from linear sRGB. */
export function oklab(color: Hsl | string): [number, number, number] {
  const [r, g, b] = hslToLinearRgb(color);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Euclidean OKLab distance ×100 — the `dataviz` skill's ΔE unit. */
export function deltaE(a: Hsl | string, b: Hsl | string): number {
  const [l1, a1, b1] = oklab(a);
  const [l2, a2, b2] = oklab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2) * 100;
}

/** OKLCH lightness and chroma — the skill's band and chroma-floor checks. */
export function oklch(color: Hsl | string): { l: number; c: number } {
  const [l, a, b] = oklab(color);
  return { l, c: Math.hypot(a, b) };
}
