import { describe, expect, test } from 'bun:test';
import { readV3Source, v3Sources } from './helpers/v3-sources';

/**
 * Where v3 meets the edges of the screen.
 *
 * In a browser tab every `env(safe-area-inset-*)` is 0, so a surface that
 * ignores them looks correct everywhere except the one place it matters: an
 * installed PWA, where the status bar eats the top and the home indicator eats
 * the bottom. That is how an unclosable menu shipped (SC-39) — the drawer's
 * grab handle sat under the top inset, invisible and untappable, and nothing
 * short of installing the app would have shown it.
 *
 * The top inset is now the primitive's problem: `BottomDrawerContent` sizes
 * itself against it, so the check here is that no consumer takes the height
 * back. The bottom inset stays each surface's own, because what has to clear
 * the home indicator differs — a scrolling body wants a spacer, a fixed bar
 * wants padding.
 */
/** Every v3 surface that reaches the bottom edge of the viewport. Two of them
 *  now ship from `@scani/ui` — see `helpers/v3-sources.ts`. */
const BOTTOM_EDGE = [
  'layouts/V3MoreDrawer.tsx',
  'layouts/V3TabBar.tsx',
  'components/PeekSheet.tsx',
  'components/capture/CaptureSheet.tsx',
  'components/form/FormSheet.tsx',
  'components/data-view/RefineSheet.tsx',
  'components/data-view/ExportSheet.tsx',
];

const files = v3Sources();

describe('v3 safe-area insets', () => {
  test('no drawer overrides the height the primitive computes', async () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = await Bun.file(file.path).text();
      if (!code.includes('<BottomDrawerContent')) continue;
      const open = code.slice(code.indexOf('<BottomDrawerContent'));
      const props = open.slice(0, open.indexOf('>'));
      // Both spellings of "I know better than the primitive". Either one puts
      // the sheet's top edge back under the status bar.
      if (/h-\[|height:/.test(props)) offenders.push(file.name);
    }
    expect(offenders).toEqual([]);
  });

  test('every surface on the bottom edge clears the home indicator', async () => {
    const missing: string[] = [];
    for (const file of BOTTOM_EDGE) {
      const code = await readV3Source(file);
      if (!code.includes('safe-area-inset-bottom')) missing.push(file);
    }
    expect(missing).toEqual([]);
  });

  test('the list of bottom-edge surfaces is still the whole list', async () => {
    // A new sheet, drawer or bar is a new chance to forget the inset. If this
    // trips, add the file above and give it its own bottom padding.
    //
    // Detected by what the file RENDERS, not by what it is called. The name
    // was the proxy until `FormSheet` arrived (SC-320 phase 3): two forms that
    // merely *use* a shell are called `…Sheet.tsx` too, and the filename rule
    // demanded a home-indicator spacer from files that never touch the bottom
    // edge — which would have put the inset in three places and left the one
    // that matters no better guarded. A drawer is `<BottomDrawerContent`; the
    // tab bar is the one bottom-edge surface that is not a drawer at all.
    const found: string[] = [];
    for (const file of files) {
      const code = await Bun.file(file.path).text();
      if (code.includes('<BottomDrawerContent') || /TabBar\.tsx$/.test(file.name)) {
        found.push(file.name);
      }
    }
    expect(found.sort()).toEqual([...BOTTOM_EDGE].sort());
  });
});
