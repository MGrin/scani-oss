/**
 * The v3 token layer, loaded once per scoping mode.
 *
 * The same design system ships twice: scoped to `[data-ui="v3"]` for
 * `apps/frontend/app`, where v2 sits beside it, and at `:root` for every app
 * that has no second system to protect. Every value assertion in
 * `v3-tokens.test.ts` runs against both, so a contrast floor cannot hold in one
 * mode and fail in the other.
 *
 * Blocks are located by what they declare rather than by their selector — that
 * is the one thing the two modes do not share.
 */

import { join } from 'node:path';
import { type CssBlock, parseCss, resolveVars } from './css-tokens';

const STYLES_DIR = join(import.meta.dir, '../../src/styles');
const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

export type TokenMode = {
  /** Raw stylesheet text — the tap-area rules are ordinary declarations. */
  css: string;
  blocks: CssBlock[];
  /** Light plus everything theme-independent. */
  baseBlock: CssBlock;
  darkBlock: CssBlock;
  reducedBlock: CssBlock | undefined;
  light: Record<string, string>;
  dark: Record<string, string>;
  themes: readonly (readonly ['dark' | 'light', Record<string, string>])[];
};

async function load(file: string): Promise<TokenMode> {
  const css = await Bun.file(join(STYLES_DIR, file)).text();
  const blocks = parseCss(css);
  const themeBlocks = blocks.filter(
    (b) => !b.atRules.includes(REDUCED_MOTION) && '--surface-0' in b.declarations
  );
  const [baseBlock, darkBlock] = themeBlocks;
  if (!baseBlock || !darkBlock) throw new Error(`${file} is missing its theme blocks`);

  const light = resolveVars(baseBlock.declarations);
  const dark = resolveVars({ ...baseBlock.declarations, ...darkBlock.declarations });

  return {
    css,
    blocks,
    baseBlock,
    darkBlock,
    reducedBlock: blocks.find(
      (b) => b.atRules.includes(REDUCED_MOTION) && '--motion-fast' in b.declarations
    ),
    light,
    dark,
    themes: [
      ['dark', dark],
      ['light', light],
    ] as const,
  };
}

export const SCOPED = await load('v3-tokens.css');
export const ROOT = await load('v3-tokens-root.css');

export const MODES = [
  ['scoped', SCOPED],
  ['root', ROOT],
] as const;
