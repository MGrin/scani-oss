import { describe, expect, test } from 'bun:test';
import { contrastRatio, parseHslTriplet, toHex } from '../helpers/contrast';
import { deltaE, oklch } from '../helpers/oklab';
import { MODES, SCOPED } from '../helpers/v3-token-modes';

const V3_SELECTOR = "[data-ui='v3']";

/** Selectors of a rule, individually — the theme blocks carry a list. */
function selectorsOf(block: { selector: string }): string[] {
  return block.selector.split(',').map((s) => s.trim());
}

function hasSelector(block: { selector: string }, selector: string): boolean {
  return selectorsOf(block).includes(selector);
}

const SURFACES = ['--surface-0', '--surface-1', '--surface-2', '--surface-hover'] as const;
/** Tokens that render text and therefore owe WCAG 1.4.3 AA on every surface. */
const TEXT_TOKENS = [
  '--foreground',
  '--muted-foreground',
  '--gain',
  '--loss',
  '--neutral',
  '--interactive',
] as const;

describe('v3 token scoping', () => {
  // The scoped file is the one v2 shares a document with, so the attribute is
  // load-bearing there and nowhere else. The `:root` variant's own scoping is
  // asserted in `v3-tokens-root.test.ts`.
  const { blocks, baseBlock, darkBlock } = SCOPED;

  test('every block is scoped to [data-ui="v3"] so v2 cannot regress', () => {
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block.selector).toInclude("[data-ui='v3']");
    }
  });

  test('data-theme pins a subtree to one theme against the document theme', () => {
    // Light needs `.dark` in the selector to out-specify the dark block
    // (0,3,0 beats 0,2,0); dark only needs the attribute, and wins on source
    // order because its rule comes second. Drop either and the kitchen sink
    // silently renders one theme twice.
    expect(hasSelector(baseBlock, `.dark ${V3_SELECTOR}[data-theme='light']`)).toBe(true);
    expect(hasSelector(baseBlock, `.dark${V3_SELECTOR}[data-theme='light']`)).toBe(true);
    expect(hasSelector(darkBlock, `${V3_SELECTOR}[data-theme='dark']`)).toBe(true);
    expect(blocks.indexOf(darkBlock)).toBeGreaterThan(blocks.indexOf(baseBlock));
  });

  test('dark applies inside a nested .dark scope, not only on <html>', () => {
    // `html:not(.dark) …` would read tidier and would silently keep light
    // tokens inside a dark container on a light page.
    expect(darkBlock.selector).toStartWith('.dark ');
    expect(darkBlock.selector).toInclude(".dark[data-ui='v3']");
  });

  test('the tap-area rules are scoped too — they are not custom properties', () => {
    // `parseCss` keeps only custom properties, so the block-level assertion
    // above cannot see these. They reach into v2's element space, which is
    // exactly where an unscoped rule would do damage.
    const flat = SCOPED.css.replace(/\s+/g, ' ');
    expect(flat).toInclude("[data-ui='v3'] :is( button,");
    expect(flat).toInclude("[data-ui='v3'] [role='switch'][data-state='unchecked']");
  });

  test('the reduced-motion catch-all is scoped — `*` would freeze v2 too', () => {
    const reset = blocks.find(
      (b) =>
        b.atRules.includes('@media (prefers-reduced-motion: reduce)') && b.selector.includes('*')
    );
    expect(reset?.selector).toInclude("[data-ui='v3'] *");
  });
});

describe.each(MODES)('%s mode', (_mode, tokens) => {
  const { baseBlock, darkBlock, reducedBlock, css, light, dark, themes } = tokens;

  describe('token structure', () => {
    test('shadcn primitives inside the v3 tree inherit the ramp', () => {
      expect(dark['--background']).toBe(dark['--surface-0'] as string);
      expect(dark['--card']).toBe(dark['--surface-1'] as string);
      expect(dark['--popover']).toBe(dark['--surface-2'] as string);
      expect(dark['--primary']).toBe(dark['--interactive'] as string);
      expect(dark['--ring']).toBe(dark['--interactive'] as string);
      // The brand hue must not leak into shadcn's subtle-hover slot.
      expect(dark['--accent']).toBe(dark['--surface-hover'] as string);
    });

    test('control boundaries take the strong border, dividers do not', () => {
      // `--input` is the only route the shadcn primitives have to a 1.4.11
      // border: Input, Textarea, SelectTrigger and the outline Button all name
      // `border-input`, and nothing else does.
      for (const [, theme] of themes) {
        expect(theme['--input']).toBe(theme['--border-strong'] as string);
        expect(theme['--input']).not.toBe(theme['--border'] as string);
      }
    });

    test('the dark block only overrides, never introduces, tokens', () => {
      for (const name of Object.keys(darkBlock.declarations)) {
        expect(Object.keys(baseBlock.declarations)).toContain(name);
      }
    });
  });

  describe.each(themes)('%s theme contrast', (_name, theme) => {
    test('a card is separable from the page it sits on', () => {
      // Deliberately not "three separable lightness steps". That assertion,
      // with `--surface-2` pinned to white, is what forced the light page down
      // to 92% and produced the grey the user rejected — a lightness ramp is a
      // dark-mode technique, and above a white page there is no headroom to
      // build one out of. What has to hold in both themes is only this: a card
      // is distinguishable from the page. In dark it earns that with a lift; in
      // light with a slight recess, a hairline and `--elevation-1`.
      const [s0, s1] = SURFACES.map((s) => theme[s] as string);
      expect(contrastRatio(s0 as string, s1 as string)).toBeGreaterThanOrEqual(1.02);
    });

    test('the hover fill is distinguishable from the surface it covers', () => {
      // Whichever direction the theme moves in, hover has to be visible.
      expect(
        contrastRatio(theme['--surface-hover'] as string, theme['--surface-1'] as string)
      ).toBeGreaterThanOrEqual(1.02);
    });

    test('--border-strong clears 3:1 against every surface (WCAG 1.4.11)', () => {
      for (const surface of SURFACES) {
        expect(
          contrastRatio(theme['--border-strong'] as string, theme[surface] as string)
        ).toBeGreaterThanOrEqual(3);
      }
    });

    test('--border is NOT held to 3:1, and is a hairline', () => {
      // 1.4.11 governs the boundary of a *control* — an input, a select, an
      // outline button — because there the border is the only thing saying the
      // control exists. It does not govern a divider or a card edge, and V3-03
      // applying it globally is exactly what put a 50%-lightness rule around
      // every card. `--border-strong` carries the requirement; this asserts the
      // split stayed split, so a future contrast sweep cannot quietly re-darken
      // the decorative token by "fixing" it.
      for (const surface of SURFACES) {
        expect(contrastRatio(theme['--border'] as string, theme[surface] as string)).toBeLessThan(
          3
        );
      }
      // Still visible, though — a hairline nobody can see is not a hairline.
      expect(
        contrastRatio(theme['--border'] as string, theme['--surface-1'] as string)
      ).toBeGreaterThanOrEqual(1.05);
    });

    test.each(TEXT_TOKENS)('%s clears 4.5:1 against every surface', (token) => {
      for (const surface of SURFACES) {
        expect(
          contrastRatio(theme[token] as string, theme[surface] as string)
        ).toBeGreaterThanOrEqual(4.5);
      }
    });

    test('foreground on a filled control clears 4.5:1', () => {
      expect(
        contrastRatio(theme['--interactive-foreground'] as string, theme['--interactive'] as string)
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(theme['--destructive-foreground'] as string, theme['--destructive'] as string)
      ).toBeGreaterThanOrEqual(4.5);
    });
  });

  describe('theme derivation', () => {
    test.each([
      '--gain',
      '--loss',
      '--neutral',
      '--interactive',
    ] as const)('%s keeps its hue across themes so identity survives a theme flip', (token) => {
      expect(parseHslTriplet(light[token] as string).h).toBe(
        parseHslTriplet(dark[token] as string).h
      );
    });

    test('gain and loss differ in luminance, not only in hue', () => {
      for (const [, theme] of themes) {
        expect(
          contrastRatio(theme['--gain'] as string, theme['--loss'] as string)
        ).toBeGreaterThanOrEqual(1.25);
      }
    });
  });

  describe('chart ramp', () => {
    /**
     * The exact hexes the `dataviz` validator was run against. Committed output:
     * `docs/implementation/2026-08-12_v3-chart-palette.md`.
     *
     * This is the one place in these tests where a duplicated table is the right
     * answer. Every other assertion derives from the stylesheet, but the CVD
     * separation checks cannot — they need the Machado simulation matrices,
     * which live in the skill rather than here. Pinning the triplets to the
     * hexes that report was produced from means an edited value fails with
     * "re-run the validator" instead of leaving a stale report claiming a
     * palette that no longer ships.
     */
    const VALIDATED = {
      light: [
        '#2977d6',
        '#eb6733',
        '#1cb07c',
        '#eba000',
        '#e87da6',
        '#008500',
        '#4b3aa6',
        '#e34a4a',
      ],
      dark: [
        '#3886e5',
        '#d95926',
        '#199f70',
        '#c28400',
        '#d55385',
        '#008500',
        '#9182e8',
        '#e66565',
      ],
    } as const;

    const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
    /** Past this, `<AllocationBar>` folds to `--chart-other`. */
    const UNRESERVED_SLOTS = [1, 2, 3, 4, 5, 6] as const;

    test.each(
      SLOTS
    )('--chart-%i keeps one hue across themes, so a series survives a theme flip', (slot) => {
      // The v2 bug this ramp exists to fix: globals.css gives the same slot
      // unrelated hues per theme, so flipping the theme reassigns which colour
      // means "crypto". Saturation and lightness are re-solved per theme; the
      // hue is one number.
      const token = `--chart-${slot}`;
      expect(parseHslTriplet(light[token] as string).h).toBe(
        parseHslTriplet(dark[token] as string).h
      );
    });

    test.each(themes)('the %s ramp is the palette the validator passed', (name, theme) => {
      expect(SLOTS.map((slot) => toHex(theme[`--chart-${slot}`] as string))).toEqual([
        ...VALIDATED[name],
      ]);
    });

    test.each(
      themes
    )('%s stays inside the skill lightness band and chroma floor', (name, theme) => {
      const [lo, hi] = name === 'light' ? [0.43, 0.77] : [0.48, 0.67];
      for (const slot of SLOTS) {
        const { l, c } = oklch(theme[`--chart-${slot}`] as string);
        expect(l).toBeGreaterThanOrEqual(lo as number);
        expect(l).toBeLessThanOrEqual(hi as number);
        // Below ~0.10 a hue reads as gray and stops doing identity work.
        expect(c).toBeGreaterThanOrEqual(0.1);
      }
    });

    test.each(
      themes
    )('in %s, each semantic token collides with a reserved slot', (_name, theme) => {
      // The ordering constraint made checkable, and the reason `<AllocationBar>`
      // folds at six. Eight hues cannot all stay clear of a violet accent and a
      // red loss token, so the collisions were *placed*: violet at slot 7 and
      // red at slot 8, past where the bar ever reaches. Reorder the ramp and
      // this fails, which is the point.
      //
      // Measured nearest slot (ΔE OKLab ×100): --interactive → slot 7 at 8.3
      // light / 4.6 dark; --loss → slot 8 at 11.1 light / 5.5 dark.
      const nearest = (token: string) =>
        SLOTS.map((slot) => ({
          slot,
          d: deltaE(theme[`--chart-${slot}`] as string, theme[token] as string),
        })).sort((a, b) => a.d - b.d)[0]?.slot;

      expect(nearest('--interactive')).toBe(7);
      expect(nearest('--loss')).toBe(8);
    });

    test.each(themes)('in %s, gain stays clear of every slot the bar can show', (_name, theme) => {
      // Green has no reserved slot to hide in — slot 6 *is* green and the bar
      // reaches it — so the requirement here is weaker but still real: gain must
      // stay above the distance at which a reader could take a rising figure for
      // a category swatch. Measured worst: 14.5 light (slot 6), 15.5 dark (slot 3).
      //
      // The residual `--loss` proximity to slots 2 and 5 in dark (10.8 / 12.3) is
      // deliberately not asserted away. A delta is text carrying a sign and an
      // arrow (`<Numeric>`, V3-07) and a slot is a fill; they never form a pair
      // the reader must tell apart by hue, which is the skill's own resolution
      // for status-versus-series proximity.
      for (const slot of UNRESERVED_SLOTS) {
        expect(
          deltaE(theme[`--chart-${slot}`] as string, theme['--gain'] as string)
        ).toBeGreaterThan(14);
      }
    });

    test.each(themes)('in %s, --chart-other reads as a fill on every surface', (_name, theme) => {
      // A mark owes WCAG 1.4.11's 3:1, not 4.5:1 — it carries no text.
      for (const surface of SURFACES) {
        expect(
          contrastRatio(theme['--chart-other'] as string, theme[surface] as string)
        ).toBeGreaterThanOrEqual(3);
      }
    });

    test.each(
      themes
    )('in %s, --chart-other is not mistakable for a slot beside it', (_name, theme) => {
      // "Other" only ever appears alongside slots 1-6, so those are the pairs
      // that matter. Measured worst: 14.3 light, 13.7 dark — both slot 1, the
      // closest hue family to a blue-gray.
      for (const slot of UNRESERVED_SLOTS) {
        expect(
          deltaE(theme['--chart-other'] as string, theme[`--chart-${slot}`] as string)
        ).toBeGreaterThan(13);
      }
    });
  });

  describe('type scale', () => {
    const roles = ['display', 'title', 'body', 'label', 'caption'] as const;
    const rem = (value: string) => Number.parseFloat(value) * 16;

    test('all six roles are defined', () => {
      for (const role of roles) {
        expect(dark[`--text-${role}-size`]).toBeDefined();
        expect(dark[`--text-${role}-weight`]).toBeDefined();
        expect(dark[`--text-${role}-line`]).toBeDefined();
      }
      expect(dark['--text-numeric-tracking']).toBeDefined();
    });

    test('body is 16px — anything smaller makes iOS zoom a focused input', () => {
      expect(rem(dark['--text-body-size'] as string)).toBe(16);
    });

    test('13px is the floor', () => {
      for (const role of roles) {
        expect(rem(dark[`--text-${role}-size`] as string)).toBeGreaterThanOrEqual(13);
      }
    });

    test('the roles descend in size', () => {
      const sizes = roles.map((role) => rem(dark[`--text-${role}-size`] as string));
      for (let i = 1; i < sizes.length; i += 1) {
        expect(sizes[i - 1] as number).toBeGreaterThan(sizes[i] as number);
      }
    });
  });

  describe('spacing scale', () => {
    const steps = [1, 2, 3, 4, 5, 6].map((n) => dark[`--space-${n}`] as string);

    test('is exactly six steps', () => {
      for (const step of steps) expect(step).toBeDefined();
      expect(dark['--space-7']).toBeUndefined();
    });

    test('is strictly increasing and 4px-based', () => {
      const px = steps.map((s) => Number.parseFloat(s) * 16);
      expect(px).toEqual([4, 8, 12, 16, 20, 24]);
      for (let i = 1; i < px.length; i += 1) {
        expect(px[i] as number).toBeGreaterThan(px[i - 1] as number);
      }
    });
  });

  describe('tap target', () => {
    const px = Number.parseFloat(dark['--tap-target'] as string) * 16;

    test('is the 44px house rule, and clears the 24px WCAG 2.5.8 AA floor', () => {
      expect(px).toBe(44);
      expect(px).toBeGreaterThanOrEqual(24);
    });

    test('is theme-independent', () => {
      expect(darkBlock.declarations['--tap-target']).toBeUndefined();
      expect(light['--tap-target']).toBe(dark['--tap-target'] as string);
    });

    test('is spent only on a coarse pointer, and never as a row height', () => {
      // The failure this guards is not a wrong number, it is the wrong scope:
      // apps/frontend/app's unscoped `button, a, [role=button] { min-height:
      // 44px }` inflates every v3 element to 44 whatever is pointing at it, and
      // the sum of that reads as a zoomed-in interface. v3 zeroes it and then
      // re-applies the minimum behind `pointer: coarse`. The reset carries over
      // to the `:root` variant unchanged so both modes size a control the same.
      // Asserted against the source text because `parseCss` keeps only custom
      // properties, and both halves of this are ordinary declarations.
      const flat = css.replace(/\s+/g, ' ');
      expect(flat).toInclude(':is( button,');
      expect(flat).toInclude('min-height: 0; min-width: 0;');
      expect(flat).toInclude('@media (pointer: coarse)');
      expect(flat).toInclude('min-height: var(--tap-target);');
      // …and nowhere outside that query, or the reset is pointless.
      const outsideCoarse = flat.slice(0, flat.indexOf('@media (pointer: coarse)'));
      expect(outsideCoarse).not.toInclude('min-height: var(--tap-target)');
    });
  });

  describe('radius', () => {
    test('is 8px — 12 reads as a bubble at control size', () => {
      expect(Number.parseFloat(light['--radius'] as string) * 16).toBe(8);
    });

    test('is theme-independent', () => {
      expect(darkBlock.declarations['--radius']).toBeUndefined();
    });
  });

  describe('elevation', () => {
    test('both themes define both steps', () => {
      for (const [, theme] of themes) {
        expect(theme['--elevation-1']).toBeDefined();
        expect(theme['--elevation-2']).toBeDefined();
        expect(theme['--elevation-1']).not.toBe(theme['--elevation-2'] as string);
      }
    });

    test('dark authors its own rather than inheriting light', () => {
      // Light spends shadow because it has no lightness headroom left; dark has
      // the ramp and needs a different, deeper shadow to read at all. Sharing
      // one value would wash out the light card or lose the dark one.
      expect(darkBlock.declarations['--elevation-1']).toBeDefined();
      expect(darkBlock.declarations['--elevation-2']).toBeDefined();
    });
  });

  describe('motion', () => {
    const durations = ['--motion-fast', '--motion-base', '--motion-slow'] as const;

    test('durations sit in the 0–400ms band', () => {
      const ms = durations.map((d) => Number.parseFloat(dark[d] as string));
      expect(ms).toEqual([...ms].sort((a, b) => a - b));
      for (const value of ms) {
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThanOrEqual(400);
      }
    });

    test('every duration collapses to 0ms under prefers-reduced-motion', () => {
      expect(reducedBlock).toBeDefined();
      for (const duration of durations) {
        expect(reducedBlock?.declarations[duration]).toBe('0ms');
      }
      expect(reducedBlock?.declarations['--motion-ease']).toBe('linear');
      expect(reducedBlock?.declarations['--motion-ease-spring']).toBe('linear');
    });

    test('the reduced-motion catch-all also defuses hard-coded keyframes', () => {
      expect(css).toInclude('animation-duration: 0.01ms !important');
      expect(css).toInclude('transition-duration: 0.01ms !important');
    });
  });
});
