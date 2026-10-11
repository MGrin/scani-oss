import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * `.sr-only` hides a real radio behind every ChoiceRow. A rule that showed it
 * again on focus put a native dot beside the drawn one on whichever row was
 * last clicked (SC-1665). Nothing focusable relies on that reveal.
 */
const css = readFileSync(resolve(import.meta.dir, '../../src/styles/accessibility.css'), 'utf8');

describe('accessibility.css', () => {
  test('a focused .sr-only element stays hidden', () => {
    expect(css).not.toMatch(/\.sr-only:focus/);
    // The control: the rule that hides it is still here.
    expect(css).toMatch(/\.sr-only \{[^}]*clip: rect\(0, 0, 0, 0\)/);
  });
});
