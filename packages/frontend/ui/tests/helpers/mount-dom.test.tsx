import { describe, expect, test } from 'bun:test';
import { PeekSheet } from '@scani/ui/v3/components/PeekSheet';
import { renderToStaticMarkup } from 'react-dom/server';
import { domSpecFiles, runDomSpecs } from './dom-specs';
import { renderDesktop } from './render-desktop';

/**
 * The `*.dom.tsx` specs, run from the main suite, and the two claims about
 * them — each with the control that makes it a measurement (SC-801).
 */

const PEEK = (
  <PeekSheet open onOpenChange={() => {}} noun="holding" spec={{ title: 'wstETH', primary: [] }} />
);

/** What happy-dom would put on `globalThis`. None exists in bun without it. */
function presentDomGlobals(): string[] {
  const g = globalThis as Record<string, unknown>;
  return ['window', 'document', 'HTMLElement'].filter((name) => name in g);
}

describe('without a DOM — the main run', () => {
  /**
   * The ticket's own measurement, kept as the control. A portal renders null
   * until it has mounted and static markup never mounts, so both branches read
   * zero bytes, which is why no static test could cover either shell.
   */
  test('static markup reads 0 bytes on both branches', () => {
    expect(renderDesktop(PEEK).length).toBe(0);
    expect(renderToStaticMarkup(PEEK).length).toBe(0);
  });
});

describe('the *.dom.tsx specs, in their own process', () => {
  const files = domSpecFiles();
  const run = runDomSpecs();

  test('there are specs to run', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  /**
   * Read per file from the child's JUnit report rather than from its exit
   * code: a child that loaded nothing exits 0 too. Every file must report, and
   * each must have run at least the desktop and phone case of one sheet.
   */
  test('every spec file ran, none failed and none skipped', () => {
    expect(
      run.files.map((entry) => entry.file),
      run.output
    ).toEqual(files);
    for (const entry of run.files) {
      expect(entry.tests, `${entry.file}\n${run.output}`).toBeGreaterThanOrEqual(2);
      expect(entry.failures, `${entry.file}\n${run.output}`).toBe(0);
      expect(entry.skipped, entry.file).toBe(0);
    }
    expect(run.exitCode, run.output).toBe(0);
  });

  /**
   * The child had a DOM and this process never did. Checked AFTER the child
   * ran, from the same process every later test file runs in.
   */
  test('no DOM global exists in the main run after the child finished', () => {
    expect(presentDomGlobals()).toEqual([]);
  });
});
