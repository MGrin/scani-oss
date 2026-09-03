import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { commentSkipper } from '../../../../../packages/frontend/ui/tests/helpers/source-scan';
import { v3Sources } from './helpers/v3-sources';

/**
 * Three token mistakes have now been rediscovered by screenshot in three
 * consecutive tickets, because each one type-checks, lints and renders — it is
 * only *invisible*. This grep is the cheap check that stops the fourth.
 *
 * It is deliberately a text scan rather than a render assertion: the failure
 * mode is a class name that never produces the rule the author expected, so
 * the class name itself is the thing worth asserting on.
 */

interface Hit {
  file: string;
  line: number;
  text: string;
}

/** Both v3 roots — the app's and `@scani/ui`'s. A class name that stopped
 *  being scanned the day its component was promoted is the fourth rediscovery
 *  this file exists to prevent. */
const SOURCES = v3Sources(['.ts', '.tsx']);

async function scan(pattern: RegExp): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const source of SOURCES) {
    const text = await Bun.file(source.path).text();
    // Every rule below is about what a class name *does*, so prose about a
    // class name is not a violation — and each of these fixes left a comment
    // behind naming the class it removed. A JSX comment is the only kind
    // available in child position, and therefore the only kind a fix inside a
    // rendered tree can leave behind; the shared reader tracks it across lines,
    // which the per-line version this replaces could not (SC-783). One skipper
    // per FILE, so block state cannot leak into the next.
    const isComment = commentSkipper();
    text.split('\n').forEach((line, index) => {
      if (isComment(line) || !pattern.test(line)) return;
      hits.push({ file: source.name, line: index + 1, text: line.trim() });
    });
  }
  return hits;
}

function format(hits: Hit[]): string[] {
  return hits.map((hit) => `${hit.file}:${hit.line} — ${hit.text}`);
}

describe('v3 token hygiene', () => {
  /**
   * Since V3-23 `--surface-2` is `0 0% 100%` in light — the same white as the
   * page. It is the correct token for something floating *above* the page
   * (a sheet, a popover, the raised thumb of a segmented control) and a no-op
   * for anything sitting *on* it. A hover or active fill is the second case,
   * and `--surface-hover` is the token that exists for it.
   */
  const ELEVATED_SURFACE_FILES = new Set([
    // The popover swatch in the surface-ramp demo, which is exactly the
    // "floats above the page" case the token is for.
    'pages/KitchenSinkPage.tsx',
  ]);

  test('no state fill uses bg-surface-2', async () => {
    const stateVariant =
      /(?:hover|focus|focus-visible|active|group-hover|data-\[[^\]]+\]|aria-\[[^\]]+\]):bg-surface-2\b/;
    expect(format(await scan(stateVariant))).toEqual([]);
  });

  test('bg-surface-2 appears only on genuinely elevated surfaces', async () => {
    const hits = (await scan(/\bbg-surface-2\b/)).filter(
      (hit) => !ELEVATED_SURFACE_FILES.has(hit.file)
    );
    expect(format(hits)).toEqual([]);
  });

  /**
   * `--border` is already the decorative hairline (225 14% 90% in light).
   * Taking a fraction of it against a white page erases the rule entirely.
   * An edge that needs to read louder wants `border-border-strong`, not a
   * higher opacity on the quiet one.
   */
  test('no border token is dimmed with an opacity modifier', async () => {
    expect(format(await scan(/\bborder-border(?:-strong)?\/\d+/))).toEqual([]);
  });

  /**
   * `min-h-tap` / `min-w-tap` are never the right answer inside v3, in either
   * direction:
   *
   * - On a control (`button`, `a`, `[role="button"]`, …) it is **inert**.
   *   V3-23's neutraliser is `[data-ui='v3'] :is(button, …)` — (0,2,1) against
   *   a utility class's (0,1,0) — and Tailwind's `@layer` directive flattens
   *   both into the same unlayered output, so specificity decides and the
   *   token rule wins. Measured on the tab bar: `min-height` computed `0px`
   *   under `pointer: fine` and `44px` under `pointer: coarse`, with and
   *   without the class.
   * - On anything else (a `div`, a skeleton row) it is *not* inert — the
   *   neutraliser does not match, so it is an unconditional 44px row height on
   *   a mouse, which is the thing V3-23 exists to undo.
   *
   * So the hit area comes from the token layer, and a surface that needs a
   * taller row asks for padding by name. See the note in
   * `components/DataRow.tsx`.
   */
  test('min-h-tap / min-w-tap are not used at all', async () => {
    expect(format(await scan(/\bmin-[hw]-tap\b/))).toEqual([]);
  });

  /**
   * The other direction of the same cascade, and the one SC-63 got backwards.
   *
   * `size="sm"` on `@scani/ui`'s Button pins `min-h-[36px]`, and SC-63 read
   * that as an opt-out of the touch floor — a size prop that silently defeats
   * an accessibility minimum. SC-73 measured it in Chromium at 390px with
   * `hasTouch`: a `sm` button inside `[data-ui='v3']` computes `min-height:
   * 44px` and renders 44px tall, and 36px only under `pointer: fine`, which is
   * the size `sm` exists to be. The floor wins for the reason the block above
   * describes — `[data-ui='v3'] :is(button, …):not(…)` is (0,3,1) against a
   * utility class's (0,1,0), flattened into the same unlayered output. So `sm`
   * is safe inside v3 and there is nothing to ban.
   *
   * What is *not* safe is anything that outranks a plain class, because the
   * floor's whole defence is specificity:
   *
   * - `!min-h-[…]` — Tailwind's important modifier emits `!important`, which
   *   beats the floor at any specificity.
   * - an inline `style={{ minHeight: '36px' }}` — (1,0,0), and inline styles
   *   beat every selector regardless.
   *
   * Neither exists in v3 today. Both would be invisible to tsgo, to Biome and
   * to the axe gate, and both would put a v3 control under 44px on a phone
   * while reading like an ordinary density tweak — which is exactly how the
   * defect this test guards gets *believed* rather than found.
   *
   * Only sub-44px literals count. `V3Shell` sets `minHeight: 'calc(3.5rem +
   * env(safe-area-inset-top))'` on the header, which is 56px before the inset
   * and is a bar rather than a control — an inline min-height is not the
   * mistake, an inline min-height *below the floor* is.
   */
  test('no v3 control outranks the coarse-pointer tap floor', async () => {
    const important = /(?:^|[\s"'`{])!min-[hw]-\[/;
    const belowFloor = /\bmin(?:Height|Width)\s*:\s*'?([\d.]+)(px|rem)/;
    const hits = [
      ...(await scan(important)),
      ...(await scan(belowFloor)).filter((hit) => {
        const match = belowFloor.exec(hit.text);
        if (!match) return false;
        const value = Number(match[1]) * (match[2] === 'rem' ? 16 : 1);
        return value < 44;
      }),
    ];
    expect(format(hits)).toEqual([]);
  });

  /**
   * The third member of the tap-floor family above, and the one neither of
   * them could have caught: an ELEMENT the floor does not reach (SC-978).
   *
   * The two tests above are about a class or an inline style outranking
   * `min-height: var(--tap-target)`. This one is about never matching it.
   * V3-23's `@media (pointer: coarse)` block spends `--tap-target` on
   * `button, [role=button], [role=tab], [role=radiogroup], a[href],
   * input[type=button|submit]`, and the unscoped v2 rule it neutralises
   * (`apps/frontend/app/src/styles/accessibility.css`) lists the same shapes.
   * A native `<select>` is in neither list, so its height is whatever the call
   * site wrote — `h-9`, 36px, on a phone.
   *
   * And the §2.6 walk is blind to exactly the same set:
   * `measureUndersizedTargets` in `apps/e2e/fixtures/a11y.ts` queries
   * `button, a[href], [role="button"], [role="tab"], summary`. So the one v3
   * control that was not a `<button>` was the one control the gate never
   * measured, which is why a 36px target survived the accessibility gate that
   * exists to find 36px targets.
   *
   * `@scani/ui`'s `Select` renders a `<button>` trigger, so it earns the floor
   * from the token layer and enters the walk's measured set. This test is the
   * cheap part: a raw `<select>` type-checks, lints, renders and passes the
   * a11y walk, so a text scan is the only thing that can see it.
   */
  test('no v3 surface uses a native select', async () => {
    // Lower-case `<select` only. `<SelectTrigger` / `<SelectContent` /
    // `<SelectItem` are the fix rather than the defect, and a JSX regex is
    // case-sensitive, so the component names cannot match; the lookahead is
    // belt-and-braces against a longer lower-case tag.
    //
    // NOT `/<select[\s>]/`, which was the first cut and could not see the very
    // element it was written for. `EntitiesPage` opened the tag on its own line
    // with the attributes below it, so the character after `select` was the end
    // of the line and neither arm of that class matched. The control below is
    // what found it — the first arm is that exact shape.
    const nativeSelect = /<select(?![\w-])/;
    // The pattern has to be able to fire, or an empty result would mean
    // nothing. Both directions: what it must catch, and what it must not.
    expect(nativeSelect.test('              <select')).toBe(true);
    expect(nativeSelect.test('<select aria-label="x">')).toBe(true);
    expect(nativeSelect.test('<select>')).toBe(true);
    expect(nativeSelect.test('                <SelectTrigger')).toBe(false);
    expect(nativeSelect.test('                <SelectValue />')).toBe(false);
    expect(nativeSelect.test("import { Select } from '@scani/ui/ui/select';")).toBe(false);

    expect(format(await scan(nativeSelect))).toEqual([]);
  });

  /**
   * A colour utility naming a token the preset does not define.
   *
   * This is the same failure the file opens with — it type-checks, it lints, it
   * renders, and it is only *invisible* — but it is the one shape the scans
   * above could not have caught, because there is nothing wrong with the class
   * except that no rule exists for it. Tailwind emits nothing for an unknown
   * colour and says nothing about it.
   *
   * Found while writing v3's review card (SC-320 slice 5): `warning` reads like
   * a design-system token and is not one. Three shipped v3 surfaces used it,
   * and `border-warning/40 bg-warning/10` on the own-wallet notice meant that
   * callout drew neither a border nor a fill — a box designed to stand out,
   * rendering as bare text.
   *
   * The list of names is derived from the preset rather than written here, so
   * adding a real `warning` token to `tailwind-preset.js` silences this on its
   * own instead of leaving a stale ban behind.
   */
  const SEMANTIC_COLOUR_NAMES = [
    'warning',
    'success',
    'info',
    'danger',
    'error',
    'positive',
    'negative',
    'caution',
  ];
  const COLOUR_PREFIXES =
    'text|bg|border|ring|fill|stroke|from|to|via|divide|outline|shadow|decoration|caret|placeholder';

  async function definedColours(): Promise<Set<string>> {
    const preset = await Bun.file(
      resolve(import.meta.dir, '../../../../../packages/frontend/ui/tailwind-preset.js')
    ).text();
    const colours = preset.slice(preset.indexOf('colors: {'));
    return new Set(
      [...colours.matchAll(/^\s{8}'?([a-z][a-z0-9-]*)'?:/gm)].map((m) => m[1] as string)
    );
  }

  test('every semantic colour utility names a token the preset defines', async () => {
    const defined = await definedColours();
    // The scan itself has to be able to see the preset, or an empty set would
    // make this pass by declaring every name undefined and then matching none.
    expect(defined.has('destructive')).toBe(true);
    expect(defined.has('surface-1')).toBe(true);

    const undefinedNames = SEMANTIC_COLOUR_NAMES.filter((name) => !defined.has(name));
    expect(undefinedNames.length).toBeGreaterThan(0);

    const pattern = new RegExp(
      `\\b(?:${COLOUR_PREFIXES})-(?:${undefinedNames.join('|')})(?:\\b|/)`
    );
    expect(pattern.test('border-warning/40 bg-warning/10')).toBe(true);
    expect(pattern.test('border-border bg-surface-hover')).toBe(false);

    expect(format(await scan(pattern))).toEqual([]);
  });
});
