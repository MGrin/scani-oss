import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

/**
 * `Sheet`'s ways out, checked in the source for the same reason as
 * `bottom-drawer.test.ts`: Radix's `Portal` renders null under
 * `renderToStaticMarkup`, and this repo has no DOM environment to mount it in.
 *
 * The two shells are a pair — a surface is a drawer below `lg` and a sheet
 * above it — so a lock that only one of them honours is a lock that depends on
 * the width of the window it was opened at.
 */
const SOURCE = await Bun.file(join(import.meta.dir, '../../src/ui/sheet.tsx')).text();

describe('sheet — the ways out', () => {
  test('every sheet is dismissible unless the caller says otherwise', () => {
    expect(SOURCE).toContain('dismissible = true');
  });

  test('Escape and the overlay are cancelled only for a non-dismissible sheet', () => {
    expect(SOURCE).toContain('onEscapeKeyDown={dismissible ? undefined : preventDismissal}');
    expect(SOURCE).toContain('onInteractOutside={dismissible ? undefined : preventDismissal}');
  });

  test('the × is absent when the sheet is not dismissible, not disabled', () => {
    // A close control that renders and refuses reads as a broken app; the
    // caller's own acknowledgement is the exit in that mode.
    expect(SOURCE).toContain('{dismissible ? (');
    expect(SOURCE.match(/<SheetPrimitive\.Close/g)).toHaveLength(1);
  });
});
