import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { COLOR_TOKENS, RADIUS } from '../../src/design-tokens/tokens';

function parseBlock(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const body = css.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

const cssPath = path.join(import.meta.dir, '../../src/styles/globals.css');
const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const light = parseBlock(css, ':root');
const dark = parseBlock(css, '.dark');

describe('design tokens stay in sync with globals.css', () => {
  it('every globals.css color var has a matching token (and vice versa)', () => {
    const cssColorVars = Object.keys(light)
      .filter((k) => k !== 'radius')
      .sort();
    const tokenKeys = Object.keys(COLOR_TOKENS).sort();
    expect(tokenKeys).toEqual(cssColorVars);
  });

  it('light + dark values match globals.css', () => {
    for (const [name, value] of Object.entries(COLOR_TOKENS)) {
      expect(value.light).toBe(light[name]);
      expect(value.dark).toBe(dark[name]);
    }
  });

  it('radius matches', () => {
    expect(RADIUS).toBe(light.radius);
  });
});
