/**
 * WCAG 2.2 contrast math over the `H S% L%` triplets the token layer stores.
 *
 * Lives in tests/ rather than src/ deliberately: nothing at runtime needs to
 * compute a contrast ratio — the tokens are static, and the point of this
 * module is to fail CI when someone edits one to a value that stops clearing
 * its threshold.
 */

export type Hsl = { h: number; s: number; l: number };

/** Parses a bare Tailwind-style `H S% L%` triplet (the form CSS vars hold). */
export function parseHslTriplet(raw: string): Hsl {
  const match = raw.trim().match(/^(-?[\d.]+)\s+(-?[\d.]+)%\s+(-?[\d.]+)%$/);
  if (!match) throw new Error(`not an "H S% L%" triplet: ${JSON.stringify(raw)}`);
  return { h: Number(match[1]), s: Number(match[2]) / 100, l: Number(match[3]) / 100 };
}

function hslToRgb({ h, s, l }: Hsl): [number, number, number] {
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
  return [r + m, g + m, b + m];
}

/** `#rrggbb` for a triplet — the form the `dataviz` validator is run against. */
export function toHex(color: Hsl | string): string {
  const hsl = typeof color === 'string' ? parseHslTriplet(color) : color;
  return `#${hslToRgb(hsl)
    .map((c) =>
      Math.round(c * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an `H S% L%` triplet. */
export function relativeLuminance(color: Hsl | string): number {
  const hsl = typeof color === 'string' ? parseHslTriplet(color) : color;
  const [r, g, b] = hslToRgb(hsl).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1–21, order-independent. */
export function contrastRatio(a: Hsl | string, b: Hsl | string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}
