import { describe, expect, test } from 'bun:test';
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

/** Every rule below is about what a class name *does*, so prose about a class
 * name is not a violation — and each of these fixes left a comment behind
 * naming the class it removed. */
function isComment(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*');
}

/** Both v3 roots — the app's and `@scani/ui`'s. A class name that stopped
 *  being scanned the day its component was promoted is the fourth rediscovery
 *  this file exists to prevent. */
const SOURCES = v3Sources(['.ts', '.tsx']);

async function scan(pattern: RegExp): Promise<Hit[]> {
  const hits: Hit[] = [];
  for (const source of SOURCES) {
    const text = await Bun.file(source.path).text();
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
});
