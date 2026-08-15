import { describe, expect, test } from 'bun:test';
import { ROOT_PATH, SCOPED_PATH, toRootScoped } from '../../scripts/build-root-tokens';
import { ROOT, SCOPED } from '../helpers/v3-token-modes';

const scopedSource = await Bun.file(SCOPED_PATH).text();
const rootSource = await Bun.file(ROOT_PATH).text();

/** Biome reformats the generated file; whitespace is not the thing being pinned. */
const normalise = (css: string) => css.replace(/\s+/g, ' ').trim();

/** The banner quotes the attribute selector to explain itself; rules must not. */
const rules = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('the :root variant is derived, not maintained', () => {
  test('matches what the generator produces from the scoped file today', () => {
    // The whole reason the `:root` variant can exist without duplicating the
    // design system. If this fails, someone hand-edited the generated file or
    // changed the scoped one without running `bun run tokens:root` — either way
    // the two modes have started to disagree.
    expect(normalise(toRootScoped(scopedSource))).toBe(normalise(rootSource));
  });

  test('declares the same tokens, with the same values, in both themes', () => {
    // Stronger than the text comparison above and independent of it: the values
    // an app actually resolves are identical whichever file it imported.
    expect(ROOT.light).toEqual(SCOPED.light);
    expect(ROOT.dark).toEqual(SCOPED.dark);
    expect(Object.keys(ROOT.baseBlock.declarations)).toEqual(
      Object.keys(SCOPED.baseBlock.declarations)
    );
  });

  test('says it is generated, so an editor is told before they edit', () => {
    expect(rootSource).toInclude('GENERATED, do not edit');
    expect(rootSource).toInclude('v3-tokens.css');
  });
});

describe(':root scoping', () => {
  test('no block carries the attribute scope — that is the whole point', () => {
    for (const block of ROOT.blocks) {
      expect(block.selector).not.toInclude('data-ui');
    }
    expect(rules(rootSource)).not.toInclude('data-ui');
  });

  test('the light block lands on :root, so no wrapper element is needed', () => {
    expect(ROOT.baseBlock.selector.split(',')[0]?.trim()).toBe(':root');
  });

  test('dark still wins on source order, and a pinned subtree still out-specifies it', () => {
    // Same cascade argument as the scoped file, one specificity step lower:
    // `:root` and `.dark` are both (0,1,0), so dark wins by coming second, and
    // `.dark [data-theme='light']` (0,2,0) beats it inside a pinned subtree.
    const darkSelectors = ROOT.darkBlock.selector.split(',').map((s) => s.trim());
    expect(darkSelectors).toContain('.dark');
    expect(darkSelectors).toContain("[data-theme='dark']");
    expect(ROOT.blocks.indexOf(ROOT.darkBlock)).toBeGreaterThan(
      ROOT.blocks.indexOf(ROOT.baseBlock)
    );

    const baseSelectors = ROOT.baseBlock.selector.split(',').map((s) => s.trim());
    expect(baseSelectors).toContain(".dark [data-theme='light']");
    expect(baseSelectors).toContain(".dark[data-theme='light']");
  });

  test('the sans face is applied at :root, not merely named there', () => {
    // Preflight sets `font-family` on <html> from `var(--font-sans, …)`, which
    // now resolves — but the explicit declaration is what makes the file
    // self-sufficient for an app that does not use the preset.
    expect(normalise(rootSource)).toInclude('font-family: var(--font-sans);');
  });
});
