import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChoiceRow } from '../../../src/v3/components/ChoiceRow';

const REPO = resolve(import.meta.dir, '../../../../../..');

function render(checked: boolean): string {
  return renderToStaticMarkup(
    <ChoiceRow name="group" checked={checked} onSelect={() => {}}>
      <span>Option</span>
    </ChoiceRow>
  );
}

describe('ChoiceRow', () => {
  test('the whole row is a label around a real radio', () => {
    const html = render(false);
    expect(html).toStartWith('<label');
    expect(html).toContain('type="radio"');
    expect(html).toContain('name="group"');
    expect(html).toContain('min-h-11');
  });

  test('the selected state is drawn, and only when checked', () => {
    expect(render(true)).toContain('border-primary bg-primary/5');
    expect(render(true)).toContain('checked=""');
    expect(render(false)).toContain('border-border bg-surface-1');
    expect(render(false)).not.toContain('checked=""');
  });

  // SC-977: both money-moving pickers once carried their own copy of this row,
  // byte-identical, so a change to one never reached the other.
  test('neither picker hand-rolls the row again', () => {
    const shell = 'min-h-11 w-full cursor-pointer items-start gap-3';
    const callers = [
      'packages/frontend/ui/src/v3/components/AccountPicker.tsx',
      'apps/frontend/app/src/v3/components/review/TransferDecision.tsx',
    ];
    for (const path of callers) {
      const source = readFileSync(resolve(REPO, path), 'utf8');
      expect(source).toContain('<ChoiceRow');
      expect(source).not.toContain(shell);
    }
    // The control: the shell is still spelled once, here, so a probe that
    // cannot match reads differently from one that finds nothing.
    const own = readFileSync(
      resolve(REPO, 'packages/frontend/ui/src/v3/components/ChoiceRow.tsx'),
      'utf8'
    );
    expect(own).toContain(shell);
  });
});
