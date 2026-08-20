import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import defaultTheme from 'tailwindcss/defaultTheme';
import preset from '../../tailwind-preset.js';
import { parseCss } from '../helpers/css-tokens';
import { ROOT, SCOPED } from '../helpers/v3-token-modes';

const STYLES_DIR = join(import.meta.dir, '../../src/styles');
const fontsCss = await Bun.file(join(STYLES_DIR, 'v3-fonts.css')).text();
const tokensCss = SCOPED.css;

const baseBlock = SCOPED.baseBlock;
const tokens = SCOPED.light;

/** Font stacks are authored across several lines; compare them as one line. */
const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim();

/** `'IBM Plex Mono', ui-monospace, …` → `["IBM Plex Mono", "ui-monospace", …]` */
function families(stack: string): string[] {
  return oneLine(stack)
    .split(',')
    .map((f) => f.trim().replace(/^['"]|['"]$/g, ''));
}

/** The `@import` targets of a stylesheet, in source order. */
function imports(css: string): string[] {
  return [...css.matchAll(/@import\s+['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
}

/**
 * The `font-family` a Fontsource stylesheet actually declares. This is the
 * check that matters most: the variable package names itself "IBM Plex Sans
 * Variable" while the static one is "IBM Plex Sans", so a plausible-looking
 * token stack can miss by one word and fall back forever without erroring.
 */
async function declaredFamilies(specifier: string): Promise<Set<string>> {
  const css = await Bun.file(Bun.resolveSync(specifier, STYLES_DIR)).text();
  return new Set(
    [...css.matchAll(/font-family:\s*(['"]?)(.+?)\1\s*;/g)].map((m) => (m[2] as string).trim())
  );
}

describe('v3 type faces', () => {
  test('the token stacks name the families the imported files declare', async () => {
    for (const specifier of imports(fontsCss)) {
      const declared = await declaredFamilies(specifier);
      expect(declared.size).toBeGreaterThan(0);
      for (const family of declared) {
        expect([
          ...families(tokens['--font-sans'] as string),
          ...families(tokens['--font-mono'] as string),
        ]).toContain(family);
      }
    }
  });

  test('Plex leads each stack, so the loaded face is the one that renders', () => {
    expect(families(tokens['--font-sans'] as string)[0]).toBe('IBM Plex Sans Variable');
    expect(families(tokens['--font-mono'] as string)[0]).toBe('IBM Plex Mono');
  });

  test('display is an alias of mono — the hero is the same face as the figures', () => {
    // Aliased rather than duplicated: two stacks can drift apart, and the
    // brief's whole type decision is that the hero *is* a figure.
    expect(baseBlock.declarations['--font-display']).toBe('var(--font-mono)');
    expect(tokens['--font-display']).toBe(tokens['--font-mono'] as string);
  });

  test('every mono fallback is monospaced, so a pre-swap digit roll cannot jitter', () => {
    // Named rather than pattern-matched: "Menlo" and "Monaco" are monospaced
    // and a name-shaped heuristic misses both, while "Noto Sans Mono UI" would
    // pass one. Adding a family to --font-mono means vouching for it here.
    const MONOSPACED = new Set([
      'ui-monospace',
      'SFMono-Regular',
      'Menlo',
      'Monaco',
      'Consolas',
      'Liberation Mono',
      'Courier New',
      'monospace',
    ]);
    const fallbacks = families(tokens['--font-mono'] as string).slice(1);
    expect(fallbacks.filter((f) => !MONOSPACED.has(f))).toEqual([]);
    expect(fallbacks.at(-1)).toBe('monospace');
  });

  test('the v3 scope applies the sans face, not merely names it', () => {
    // Preflight puts `font-family` on <html>, where --font-sans is undefined;
    // descendants inherit that computed stack, so the scope must set its own.
    // Every block in this file is v3-scoped (asserted in v3-tokens.test.ts),
    // so finding the declaration anywhere in it places it inside the scope.
    expect(oneLine(tokensCss)).toInclude('font-family: var(--font-sans);');
  });

  test('one mono file is loaded per weight the type scale asks for', () => {
    const weights = new Set(
      Object.entries(baseBlock.declarations)
        .filter(([name]) => /^--text-.*-weight$/.test(name))
        .map(([, value]) => value)
    );
    expect(weights.size).toBeGreaterThan(0);

    const monoImports = imports(fontsCss).filter((i) => i.includes('ibm-plex-mono'));
    for (const weight of weights) {
      expect(monoImports).toContain(`@fontsource/ibm-plex-mono/latin-${weight}.css`);
    }
    // Exactly those weights — an unused face is a payload nobody asked for.
    expect(monoImports).toHaveLength(weights.size);
  });

  test('the sans variable axis covers every weight the type scale asks for', async () => {
    const css = await Bun.file(
      Bun.resolveSync('@fontsource-variable/ibm-plex-sans/wght.css', STYLES_DIR)
    ).text();
    const range = css.match(/font-weight:\s*(\d+)\s+(\d+)/);
    expect(range).not.toBeNull();
    const [low, high] = [Number(range?.[1]), Number(range?.[2])];
    for (const [name, value] of Object.entries(baseBlock.declarations)) {
      if (!/^--text-.*-weight$/.test(name)) continue;
      expect(Number(value)).toBeGreaterThanOrEqual(low);
      expect(Number(value)).toBeLessThanOrEqual(high);
    }
  });

  test('no italic cut is loaded — nothing in v3 sets font-style', () => {
    for (const specifier of imports(fontsCss)) {
      expect(specifier).not.toInclude('italic');
    }
  });

  test('faces are self-hosted — no Google Fonts CDN on the critical path', () => {
    expect(fontsCss).not.toInclude('fonts.googleapis.com');
    expect(fontsCss).not.toInclude('fonts.gstatic.com');
  });

  test('the file carries no scope, so both token modes import the same one', () => {
    // `@font-face` cannot be scoped to a selector anyway, so this file is
    // nothing but `@import`s — which is what lets landing / cloud / admin pair
    // it with the `:root` token variant without dragging in `[data-ui="v3"]`.
    // Declaring a face applies nothing and browsers fetch lazily, so an app
    // that imports it and never names the families downloads no files.
    expect(parseCss(fontsCss)).toEqual([]);
    expect(fontsCss.replace(/\/\*[\s\S]*?\*\//g, '').trim()).toMatch(/^(@import\s+'[^']+';\s*)+$/);
  });

  test('both token modes name the families this file declares', () => {
    for (const mode of [SCOPED, ROOT]) {
      expect(mode.light['--font-sans']).toContain('IBM Plex Sans Variable');
      expect(mode.light['--font-mono']).toContain('IBM Plex Mono');
    }
  });
});

describe('preset font wiring', () => {
  const fonts = preset.theme?.extend?.fontFamily as Record<string, string>;

  test.each([
    ['sans', defaultTheme.fontFamily.sans],
    ['mono', defaultTheme.fontFamily.mono],
  ])('%s falls back to Tailwind’s own default, so v2 cannot shift', (key, fallback) => {
    // The vars exist only under [data-ui="v3"]. Everywhere else — v2, cloud,
    // landing, admin, and preflight's own `html { font-family }` — this must
    // resolve to the byte-identical stack it resolved to before V3-20.
    const match = (fonts[key] as string).match(/^var\(--font-[\w-]+,\s*(.+)\)$/);
    expect(match).not.toBeNull();
    expect(oneLine(match?.[1] as string)).toBe((fallback as string[]).join(', '));
  });

  test('display is a real utility reading a real token', () => {
    expect(fonts.display).toStartWith('var(--font-display,');
    expect(baseBlock.declarations['--font-display']).toBeDefined();
  });

  test('display tracking is not negative — mono cells are already spaced', () => {
    // -0.02em was tuned for a proportional face. On Plex Mono it closes the
    // gap between figures and puts letter-spacing on top of the `1ch` advance
    // a digit roll measures against.
    expect(Number.parseFloat(tokens['--text-display-tracking'] as string)).toBe(0);
  });
});
