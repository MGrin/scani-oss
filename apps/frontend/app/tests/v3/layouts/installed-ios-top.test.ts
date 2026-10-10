import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

/**
 * In the installed iOS app the top of every page spent ~17% of the screen
 * before the page title (SC-1632). The header and the gap under it are now
 * tightened there and only there: each value is a variable whose default is
 * the old one, overridden in the same installed-iOS block as SC-1597's
 * clearance, so Safari tabs, Android and desktop are unchanged.
 */

const root = join(import.meta.dir, '../../../../../..');
const read = (path: string) => Bun.file(join(root, path)).text();

async function blocks() {
  const css = await read('packages/frontend/ui/src/styles/globals.css');
  const start = css.indexOf('@supports (-webkit-touch-callout: none)');
  expect(start).toBeGreaterThan(0);
  return { defaults: css.slice(0, start), installed: css.slice(start, css.indexOf('}\n}', start)) };
}

describe('the installed iOS app tightens the top of the page (SC-1632)', () => {
  test.each([
    ['--scani-header-row', '3.5rem', '2.75rem'],
    ['--scani-header-border', '1px', '0px'],
    ['--scani-page-top', '1.5rem', '0.75rem'],
  ])('%s is %s everywhere and %s installed', async (name, plain, installed) => {
    const css = await blocks();
    expect(css.defaults).toContain(`${name}: ${plain};`);
    expect(css.installed).toContain(`${name}: ${installed};`);
  });

  test('the shell header reads the row height and border from those variables', async () => {
    const shell = await read('apps/frontend/app/src/v3/layouts/V3Shell.tsx');
    const header = shell.slice(shell.indexOf('<header'), shell.indexOf('</header>'));
    expect(header).toContain('var(--scani-header-row)');
    expect(header).toContain("borderBottomWidth: 'var(--scani-header-border)'");
    expect(header).not.toContain('3.5rem');
    expect(header).not.toContain('h-14');
  });

  test('the page reads its top padding from --scani-page-top, below the desktop breakpoint', async () => {
    const layout = await read('packages/frontend/ui/src/v3/components/PageLayout.tsx');
    expect(layout).toContain(
      "const PADDING = 'px-4 pb-6 pt-[var(--scani-page-top)] lg:px-6 lg:py-5';"
    );
  });
});
