import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

/**
 * An installed iOS app gets the system's scroll-edge blur over the top
 * ~2rem past the status bar on iOS 27, measured in the Simulator (SC-1597, SC-1632). Content padded by the inset alone
 * renders blurred, so every top element reads `--scani-inset-top`, which adds
 * the clearance only in the installed app on iOS, in portrait.
 */

const css = await Bun.file(join(import.meta.dir, '../../src/styles/globals.css')).text();
const repo = join(import.meta.dir, '../../../../..');
const read = (path: string) => Bun.file(join(repo, path)).text();

describe('the top edge clears the iOS edge blur', () => {
  test('the plain value is the inset, so browsers and Android do not move', () => {
    expect(css).toMatch(/:root\s*{\s*--scani-inset-top: env\(safe-area-inset-top, 0px\);/);
  });

  test('the clearance applies only to the installed iOS app in portrait', () => {
    const block = css.slice(css.indexOf('@supports (-webkit-touch-callout: none)'));
    expect(block).toContain('@media (display-mode: standalone) and (orientation: portrait)');
    expect(block).toContain('--scani-inset-top: calc(env(safe-area-inset-top, 0px) + 2rem);');
  });

  test.each([
    'apps/frontend/app/src/v3/billing/PlanBanner.tsx',
    'apps/frontend/app/src/v3/components/DemoBanner.tsx',
    'packages/frontend/ui/src/components/UpdateBanner.tsx',
    'packages/frontend/ui/src/components/InstallPromptBanner.tsx',
  ])('%s pads by the clearance, not the bare inset', async (path) => {
    const source = await read(path);
    expect(source).toContain('var(--scani-inset-top, env(safe-area-inset-top, 0px))');
    const code = source
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n')
      .replaceAll('var(--scani-inset-top, env(safe-area-inset-top, 0px))', '');
    expect(code).not.toContain('env(safe-area-inset-top');
  });
});
