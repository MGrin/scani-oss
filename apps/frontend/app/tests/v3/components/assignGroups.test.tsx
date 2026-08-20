import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import i18n from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { GroupChecklist } from '@/v3/components/groups/AssignGroupsSheet';
import {
  createAndAssignBlockers,
  describeAssignment,
  groupAssignmentDiff,
  isEmptyDiff,
} from '@/v3/lib/assign-groups';

const t = i18n.t.bind(i18n);

const GROUPS = [
  { id: 'g1', name: 'Retirement', color: '#ef4444' },
  { id: 'g2', name: 'Taxable', color: '#3b82f6' },
];

describe('the save is a diff, never a replace', () => {
  test('a group left ticked is neither added nor removed', () => {
    const diff = groupAssignmentDiff(new Set(['g1']), new Set(['g1']));
    expect(diff).toEqual({ addedGroupIds: [], removedGroupIds: [] });
    expect(isEmptyDiff(diff)).toBe(true);
  });

  test('ticking one adds only it', () => {
    expect(groupAssignmentDiff(new Set(['g1']), new Set(['g1', 'g2']))).toEqual({
      addedGroupIds: ['g2'],
      removedGroupIds: [],
    });
  });

  test('unticking one removes only it', () => {
    expect(groupAssignmentDiff(new Set(['g1', 'g2']), new Set(['g2']))).toEqual({
      addedGroupIds: [],
      removedGroupIds: ['g1'],
    });
  });

  /**
   * The property the whole module exists for. The list only ever shows the
   * groups EVERY selected row already shares, so a group one row has on its own
   * is never drawn — and must therefore never be written. A replace-style save
   * would send the ticked set and silently take that row out of it.
   */
  test('a group the list never showed is not touched by a save', () => {
    // `g9` is on one holding of the batch, so it is not in the intersection and
    // never reached the checkbox list.
    const shown = new Set(['g1']);
    const diff = groupAssignmentDiff(shown, new Set(['g1', 'g2']));
    expect(diff.removedGroupIds).not.toContain('g9');
    expect(diff.addedGroupIds).not.toContain('g9');
  });
});

describe('what the save says it did', () => {
  test('an addition alone counts the groups it added', () => {
    expect(describeAssignment({ addedGroupIds: ['g1'], removedGroupIds: [] }, t)).toBe(
      'Added to 1 group'
    );
    expect(describeAssignment({ addedGroupIds: ['g1', 'g2'], removedGroupIds: [] }, t)).toBe(
      'Added to 2 groups'
    );
  });

  test('a removal alone says removal — v2 called it "Groups assigned"', () => {
    expect(describeAssignment({ addedGroupIds: [], removedGroupIds: ['g1'] }, t)).toBe(
      'Removed from 1 group'
    );
  });

  /**
   * One whole string rather than two fragments joined. A language that inflects
   * the verb for the count cannot be served by "Added to 2 groups" glued to
   * ", removed from 1" — SC-235's rule.
   */
  test('both directions at once is a single sentence a translator owns', () => {
    expect(describeAssignment({ addedGroupIds: ['g1'], removedGroupIds: ['g2'] }, t)).toBe(
      'Groups updated'
    );
  });
});

describe('the empty state names what is missing', () => {
  test('no name is a blocker, not a silently dead button', () => {
    expect(createAndAssignBlockers('   ', t)).toEqual(['name the group']);
    expect(createAndAssignBlockers('Retirement', t)).toEqual([]);
  });
});

describe('GroupChecklist', () => {
  const markup = (selected: string[]) =>
    renderToStaticMarkup(
      <GroupChecklist
        groups={GROUPS}
        selectedIds={new Set(selected)}
        onToggle={() => {}}
        disabled={false}
      />
    );

  /**
   * v2 wrapped a Radix `Checkbox` — itself a `<button role="checkbox">` — in
   * the row's own `<button>`. That is axe's `nested-interactive`: one choice
   * exposed as two controls, the inner one 16px. One control per row now.
   */
  test('a row is one control, not a button inside a button', () => {
    const html = markup(['g1']);
    expect(html.match(/<button/g)).toHaveLength(GROUPS.length);
    expect(html).toContain('role="checkbox"');
  });

  test('the checked state is on the control a screen reader reads', () => {
    expect(markup(['g1'])).toContain('aria-checked="true"');
    expect(markup([])).not.toContain('aria-checked="true"');
    expect(markup([])).toContain('aria-checked="false"');
  });

  test('every group is named', () => {
    const html = markup([]);
    expect(html).toContain('Retirement');
    expect(html).toContain('Taxable');
  });

  /** The colour dot and the drawn box are decoration; the name is the label. */
  test('the marks beside the name are hidden from assistive tech', () => {
    expect(markup(['g1']).match(/aria-hidden="true"/g)?.length).toBeGreaterThanOrEqual(
      GROUPS.length * 2
    );
  });
});

/**
 * Two source guards. Neither is a rendering assertion, because `FormSheet` is a
 * Radix dialog and Radix renders nothing under `renderToStaticMarkup` — the
 * same reason `customTokenSheets.test.tsx` tests the halves rather than the
 * sheet. This is the technique `route-split` and `safe-area` already use.
 */
describe('the sheet source', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../../../src/v3/components/groups/AssignGroupsSheet.tsx'),
    'utf8'
  );

  /**
   * Both action rows on screen at once put two "Cancel" buttons 80px apart —
   * one abandoning the half-typed group, one abandoning the whole assignment —
   * with nothing on either saying which. Found by opening it in a browser;
   * type-check was clean and every test above was green.
   */
  test('the sheet actions are hidden while the create sub-form is open', () => {
    expect(source).toContain('{creating ? null : (');
  });

  /**
   * With the sheet's own failure line suppressed while creating, a rejected
   * `groups.create` would otherwise fail silently — v3 forms do not toast.
   */
  test('the create sub-form carries its own failure line', () => {
    const subForm = source.slice(
      source.indexOf('{creating ? ('),
      source.indexOf('{creating ? null')
    );
    expect(subForm).toContain('role="alert"');
  });
});
