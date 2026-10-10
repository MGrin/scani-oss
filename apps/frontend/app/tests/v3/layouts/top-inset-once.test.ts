import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

/**
 * The top clearance (SC-1597) is applied ONCE, by whatever is topmost. With the
 * plan or demo banner showing, the banner takes it and the header follows it
 * directly; with an update or install banner fixed on top, that banner's
 * height already covers it. Only with nothing above it does the header take
 * the clearance. The header used to take it as well, which put it ~40px too
 * low under the plan banner in the installed iPhone app.
 */

const app = join(import.meta.dir, '../../..');
const read = (path: string) => Bun.file(join(app, path)).text();

describe('the top clearance is applied once', () => {
  test('the shell header pads by the header inset, not the clearance', async () => {
    const shell = await read('src/v3/layouts/V3Shell.tsx');
    const header = shell.slice(shell.indexOf('<header'), shell.indexOf('</header>'));
    expect(header).toContain("'var(--scani-header-inset)'");
    // Shown, the bar's row plus the inset; hidden on scroll, the inset alone (SC-1631).
    expect(header).toContain("'calc(var(--scani-header-row) + var(--scani-header-inset))'");
    expect(header).not.toContain('--scani-inset-top');
  });

  // Hidden, the header gives up the inset too: the page scrolls under the
  // status bar, as mgrin asked on his iPhone, instead of leaving a band (SC-1631).
  test('a hidden header keeps no band under the status bar', async () => {
    const shell = await read('src/v3/layouts/V3Shell.tsx');
    const header = shell.slice(shell.indexOf('<header'), shell.indexOf('</header>'));
    expect(header).toContain("paddingTop: chrome.hidden ? 0 : 'var(--scani-header-inset)'");
    expect(header).toMatch(/minHeight: chrome\.hidden\s*\?\s*0\b/);
  });

  test('a hidden tab bar leaves only the home-indicator inset below the page', async () => {
    const shell = await read('src/v3/layouts/V3Shell.tsx');
    expect(shell).toContain(
      "height: chrome.hidden ? 'env(safe-area-inset-bottom, 0px)' : V3_TAB_BAR_SPACER"
    );
  });

  test('the header inset is the clearance minus a fixed banner above it, never negative', async () => {
    const css = await read('src/styles/v3-shell.css');
    expect(css).toMatch(
      /\[data-v3-shell\]\s*{\s*--scani-header-inset: max\(\s*0px,\s*calc\(var\(--scani-inset-top, env\(safe-area-inset-top, 0px\)\) - var\(--scani-banner-offset, 0px\)\)\s*\);/
    );
  });

  test('an in-flow top banner takes the clearance and the header takes none', async () => {
    const css = await read('src/styles/v3-shell.css');
    expect(css).toMatch(
      /\[data-v3-shell\]:has\(> \[data-top-banner\]\)\s*{\s*--scani-header-inset: 0px;/
    );
  });

  test.each(['src/v3/billing/PlanBanner.tsx', 'src/v3/components/DemoBanner.tsx'])(
    '%s marks itself as the top banner',
    async (path) => {
      expect(await read(path)).toContain('data-top-banner');
    }
  );

  test('the shell carries the attribute the rule keys on, and loads the rule', async () => {
    expect(await read('src/v3/layouts/V3Shell.tsx')).toMatch(/<V3TokenScope[\s\S]*?\n\s*shell\n/);
    expect(await read('src/v3/components/V3TokenScope.tsx')).toContain(
      "data-v3-shell={shell ? '' : undefined}"
    );
    expect(await read('src/index.css')).toContain('@import "./styles/v3-shell.css";');
  });
});
