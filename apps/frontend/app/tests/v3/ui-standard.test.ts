import { describe, expect, test } from 'bun:test';
import { Button } from '@scani/ui/ui/button';
import { Sheet } from '@scani/ui/ui/sheet';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { PeekHeader } from '@scani/ui/v3/components/PeekSheet';
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { commentSkipper } from '../../../../../packages/frontend/ui/tests/helpers/source-scan';
import { v3Sources } from './helpers/v3-sources';

/**
 * The mechanical half of the UI standard (SC-1410,
 * `docs/technical/2026-09-28_ui-patterns.md`).
 *
 * Each rule is a ratchet: the violations that exist today are pinned by file
 * with the row that removes them, a NEW violation fails, and a pinned entry
 * that no longer violates fails too — so the list can only shrink, and cannot
 * go stale by being fixed and forgotten. A pinned entry is a declared
 * exception with an owner, not an escape hatch: add one only with a row that
 * removes it, and say so in the standard's "Known violations" table.
 */
const files = v3Sources();

async function sourceWithoutComments(path: string): Promise<string> {
  const isComment = commentSkipper();
  const text = await Bun.file(path).text();
  return text
    .split('\n')
    .map((line) => (isComment(line) ? '' : line))
    .join('\n');
}

/** Each `<Name …>` opening tag, props only, braces balanced. */
function openingTags(text: string, name: string): { tag: string; end: number }[] {
  const tags: { tag: string; end: number }[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(`<${name}`, from);
    if (start < 0) return tags;
    let depth = 0;
    let i = start + name.length + 1;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (depth === 0 && ch === '>') break;
    }
    tags.push({ tag: text.slice(start, i + 1), end: i + 1 });
    from = i + 1;
  }
}

function confirmActionTags(text: string): string[] {
  return openingTags(text, 'ConfirmAction').map((t) => t.tag);
}

/**
 * A `FormSheet` whose actions are not in its pinned footer: no `footer=` prop,
 * or a `FormActions` inside the body, between the opening tag and its close.
 */
function formSheetsWithBodyActions(text: string): number {
  return openingTags(text, 'FormSheet').filter(({ tag, end }) => {
    if (!/\sfooter=/.test(tag)) return true;
    const close = text.indexOf('</FormSheet>', end);
    return text.slice(end, close < 0 ? text.length : close).includes('<FormActions');
  }).length;
}

function propValue(tag: string, prop: string): string | undefined {
  const at = tag.search(new RegExp(`\\s${prop}=`));
  if (at < 0) return undefined;
  const start = tag.indexOf('=', at) + 1;
  if (tag[start] === '"' || tag[start] === "'") {
    return tag.slice(start, tag.indexOf(tag[start] as string, start + 1) + 1);
  }
  let depth = 0;
  for (let i = start; i < tag.length; i++) {
    if (tag[i] === '{') depth++;
    else if (tag[i] === '}' && --depth === 0) return tag.slice(start, i + 1).replace(/\s+/g, ' ');
  }
  return undefined;
}

/** A text control: typing a value is what makes a component an editor. */
const TEXT_CONTROL =
  /from '@scani\/ui\/ui\/(input|textarea)'|from '@scani\/ui\/v3\/components\/AmountInput'/;

/**
 * A `DataViewTable` column whose header names a figure but is not `numeric`:
 * its header then sits at the start of a wide cell while the figure is
 * right-aligned at the row's edge (rule 4, SC-1433 — the vault detail table).
 */
const FIGURE_HEADER = /\.col\.(amount|value|price|balance|saved|target|drift|gainLoss)'/;
function figureColumnsNotNumeric(text: string): number {
  return [
    ...text.matchAll(/headerKey: ('[^']+'),([\s\S]*?)(?=\n\s*\{\s*\n\s*key:|\n\s*\],)/g),
  ].filter(
    ([, header, body]) => FIGURE_HEADER.test(header ?? '') && !/numeric: true/.test(body ?? '')
  ).length;
}

/**
 * A `FormSheet` whose `title` or `description` is not a keyed sentence — a
 * bare record value such as `{group.name}` (rule 13, SC-1436).
 */
function formSheetsWithUnkeyedHeader(text: string): number {
  return openingTags(text, 'FormSheet').filter(({ tag }) =>
    ['title', 'description'].some((prop) => {
      const value = propValue(tag, prop);
      return value !== undefined && !/\bt\(/.test(value);
    })
  ).length;
}

async function countBy(
  match: (text: string, name: string) => number
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const file of files) {
    const n = match(await sourceWithoutComments(file.path), file.name);
    if (n > 0) out[file.name] = n;
  }
  return out;
}

describe('UI standard (SC-1410)', () => {
  test('rule 2: no create action inside a list toolbar', async () => {
    const found = await countBy((text, name) =>
      name.endsWith('data-view/V3DataView.tsx')
        ? 0
        : (text.match(/\btoolbarAction\s*[:=]/g) ?? []).length
    );
    // SC-1411 removed the last two, and the prop with them.
    expect(found).toEqual({});
  });

  test('rule 1: a page titles itself through PageHeader, never a bare h1', async () => {
    // Holdings rendered its own `<h1>` and sat 14px above every other list
    // page, so the title jumped between tabs (SC-1433). `PageHeader` holds
    // the row at a button's height whether or not there is an action.
    const found = await countBy((text, name) =>
      name.startsWith('pages/') ? (text.match(/<h1[\s>]/g) ?? []).length : 0
    );
    expect(found).toEqual({
      // Home's title is visually absent by decision (standard, "Deliberate
      // exceptions"); the h1 is for screen readers only.
      'pages/HomePage.tsx': 1,
      // A detail page's title shares its row with the record's own mark and
      // actions, which is a detail header, not a page header.
      'pages/GroupDetailPage.tsx': 1,
      'pages/VaultDetailPage.tsx': 1,
      // An error page, with an icon inside its title.
      'pages/NotFoundPage.tsx': 1,
    });
  });

  test('rule 9: a fixed choice is Select or Segmented, never hand-made radios', async () => {
    // Record movement drew its "Where did it go?" as radio cards whose titles
    // were set larger than every field label, while Edit holding asked the
    // same question with a vertical Segmented (SC-1433).
    const found = await countBy((text) => (text.match(/type="radio"/g) ?? []).length);
    expect(found).toEqual({
      // The record picker's row, not a fixed option: each choice is one of
      // the user's own records, with its own figures.
      'components/ChoiceRow.tsx': 1,
    });
  });

  test('rule 3: no new centred dialog; overlays are the sheet family', async () => {
    const found = await countBy((text) =>
      /from '@scani\/ui\/ui\/dialog'|from '@scani\/ui\/components\/ConfirmDialog'/.test(text)
        ? 1
        : 0
    );
    // SC-1413 moved the last six to FormSheet, PeekSheet and ConfirmAction.
    expect(found).toEqual({
      // The component gallery shows every primitive on purpose.
      'pages/KitchenSinkPage.tsx': 1,
    });
  });

  test("rule 3: a form sheet's actions are in its pinned footer, never its body", async () => {
    // SC-1418: on desktop a body-scrolled action row took the header with it.
    expect(await countBy(formSheetsWithBodyActions)).toEqual({});
  });

  test('rule 6: a destructive confirm is red at rest', async () => {
    const found = await countBy(
      (text) =>
        confirmActionTags(text).filter(
          (tag) => /\sdestructive(\s|=|\/|>)/.test(tag) && !/text-destructive/.test(tag)
        ).length
    );
    // SC-1412 made the last seven red at rest.
    expect(found).toEqual({});
  });

  test('rule 6: the confirm label is a different sentence from the button', async () => {
    const found = await countBy(
      (text) =>
        confirmActionTags(text).filter((tag) => {
          const label = propValue(tag, 'label');
          return label !== undefined && label === propValue(tag, 'confirmLabel');
        }).length
    );
    // SC-1411 gave the last two their own confirm sentence.
    expect(found).toEqual({});
  });

  test("rule 4: a table cell's second line is a muted caption, never a bare <small>", async () => {
    const found = await countBy((text) => (text.match(/<small\b/g) ?? []).length);
    // SC-1433 gave the group and vault member tables the Holdings shape.
    expect(found).toEqual({});
  });

  test('rule 8: an empty state offers the main action or nothing, never an outline link', async () => {
    const found = await countBy((text) => {
      let count = 0;
      for (const match of text.matchAll(/\bempty(?::\s*\{|=\{\{)/g)) {
        const rest = text.slice(match.index ?? 0);
        const end = rest.search(/\n\s*(peek|columns|renderBulkActions|summary|getRow):|\/>/);
        if (/variant="outline"/.test(end < 0 ? rest : rest.slice(0, end))) count++;
      }
      return count;
    });
    // SC-1433 took the last four out.
    expect(found).toEqual({});
  });

  test("rule 1: a page header's action is a create action, drawn with Plus", async () => {
    const found = await countBy(
      (text) =>
        openingTags(text, 'PageHeader')
          .map((t) => propValue(t.tag, 'action') ?? '')
          .filter((action) =>
            [...action.matchAll(/<([A-Z]\w*) className="me-1\.5 size-4"/g)].some(
              (m) => m[1] !== 'Plus'
            )
          ).length
    );
    // SC-1433 gave Files its Plus.
    expect(found).toEqual({});
  });

  test('rule 6: a delete carries the Trash2 icon, and its hover stays red', async () => {
    const found = await countBy(
      (text) =>
        confirmActionTags(text).filter((tag) => {
          const label = propValue(tag, 'label') ?? '';
          // Keyed on the trigger's translation key, not on any identifier in
          // the label: deleting the whole account is `UserX` on purpose.
          if (!/t\('[^']*[dD]elete[^']*'\)/.test(label)) return false;
          return !/<Trash2\b/.test(label) || !/hover:text-destructive/.test(tag);
        }).length
    );
    // SC-1433 gave the payee, payment and bulk deletes theirs.
    expect(found).toEqual({});
  });

  test("rule 12: a record peek's confirm trigger leads with an icon, like the actions beside it", async () => {
    // Scoped to the record peeks, whose actions share one icon grid. A review
    // queue's answers and a settings or job row are not in that grid.
    const recordPeek = /^(components\/(holdings|money|vaults|membership)\/|pages\/VaultDetailPage)/;
    const found = await countBy(
      (text, name) =>
        confirmActionTags(text).filter((tag) => {
          if (!recordPeek.test(name)) return false;
          const label = propValue(tag, 'label') ?? '';
          // A label passed as a bare string or variable has nowhere to carry
          // one. Deactivate and "Remove interest configuration" were the two
          // text-only triggers in the holding peek (SC-1433).
          return !/<[A-Z]\w* className="me-2 size-4"/.test(label);
        }).length
    );
    expect(found).toEqual({});
  });

  test('rule 12: a red-at-rest confirm declares `destructive`, so a peek can place it', async () => {
    const found = await countBy(
      (text) =>
        confirmActionTags(text).filter(
          (tag) => /text-destructive/.test(tag) && !/\sdestructive(\s|=|\/|>)/.test(tag)
        ).length
    );
    expect(found).toEqual({});
  });

  test('rule 12: a peek offers no overflow menu', async () => {
    const found = await countBy((text) =>
      /\bprimary:/.test(text) && /\bactions:/.test(text) && /ui\/dropdown-menu'/.test(text) ? 1 : 0
    );
    expect(found).toEqual({});
  });

  test("rule 3: a sheet's body scrolls through ScrollBody, which fades its edges", async () => {
    const found = await countBy((text) =>
      /<SheetContent|<BottomDrawerContent/.test(text)
        ? (text.match(/overflow-y-auto/g) ?? []).length
        : 0
    );
    // SC-1433 moved the form and peek bodies onto it.
    expect(found).toEqual({});
  });

  test('rule 3: a page creates and edits in a sheet, not an inline form', async () => {
    const found = await countBy((text, name) =>
      name.startsWith('pages/') && /from '@scani\/ui\/ui\/input'/.test(text) ? 1 : 0
    );
    // SC-1419 moved New group, New vault, New payee and both Edit details
    // editors into FormSheets.
    expect(found).toEqual({
      // Capture flows are pages by design (rule 7, `CaptureHeader`).
      'pages/IntegrationConnectPage.tsx': 1,
      'pages/ManualEntryPage.tsx': 1,
      'pages/WalletImportPage.tsx': 1,
      // The component gallery shows every primitive on purpose.
      'pages/KitchenSinkPage.tsx': 1,
    });
  });

  test('rule 13: an edit panel is titled and described in keyed sentences', async () => {
    // SC-1436: two edit sheets put the record's own name where the sentence
    // about the form goes, so the same panel read differently per record.
    expect(await countBy(formSheetsWithUnkeyedHeader)).toEqual({});
  });

  test('rule 13: a form sheet groups fields in FormSection, never a card', async () => {
    // SC-1436: the bill form drew each section as a `Block` — a box in a box,
    // and the one edit panel that looked unlike the rest.
    const found = await countBy((text) =>
      text.includes('<FormSheet') && /<Block[\s>]|<FieldSet[\s>]/.test(text) ? 1 : 0
    );
    expect(found).toEqual({});
  });

  test('rule 13: nothing destructive inside an edit panel', async () => {
    const found = await countBy((text) =>
      text.includes('<FormSheet') && text.includes('<ConfirmAction') ? 1 : 0
    );
    expect(found).toEqual({});
  });

  test('rule 13: a record is edited in a sheet, never in place', async () => {
    const found = await countBy((text, name) =>
      name.startsWith('components/') && TEXT_CONTROL.test(text) && !text.includes('<FormSheet')
        ? 1
        : 0
    );
    expect(found).toEqual({
      // Fields: rendered inside a FormSheet or a capture page, never alone.
      'components/capture/AccountField.tsx': 1,
      'components/capture/InstitutionField.tsx': 1,
      'components/form/RecordPicker.tsx': 1,
      'components/holdings/HoldingEditCause.tsx': 1,
      'components/holdings/MovementFields.tsx': 1,
      'components/money/PaymentGroupsPicker.tsx': 1,
      'components/review/BalanceGapAnswerFields.tsx': 1,
      // Settings is a form page of its own, and its fields auto-save.
      'components/settings/ProfileSettings.tsx': 1,
      // A destructive action's chooser (rule 6): the box filters which payee
      // to merge in, and no value is typed into any record.
      'components/money/DuplicateVendorPicker.tsx': 1,
      // A form page's own form: the import review edits every parsed row and
      // submits them once, as a capture page does.
      'components/jobs/ReviewHoldingsCard.tsx': 1,
    });
  });

  test('rule 13: no icon-only pencil; the way in is the labelled Edit action', async () => {
    const found = await countBy((text) => (text.match(/<Pencil className="size-/g) ?? []).length);
    expect(found).toEqual({});
  });

  test('rule 4: a column headed by a figure is numeric, so its header sits over its values', async () => {
    const found = await countBy((text) => figureColumnsNotNumeric(text));
    expect(found).toEqual({});
  });

  test('rule 4: a figure column is never hidden on a narrow desktop', async () => {
    const found = await countBy(
      (text) =>
        [
          ...text.matchAll(/headerKey: ('[^']+'),([\s\S]*?)(?=\n\s*\{\s*\n\s*key:|\n\s*\],)/g),
        ].filter(([, , body]) => /numeric: true/.test(body ?? '') && /hideBelow:/.test(body ?? ''))
          .length
    );
    expect(found).toEqual({});
  });

  /** The scanners above must be able to see a violation, or every pin is vacuous. */
  test('CONTROL: the form-sheet scanner finds both shapes it forbids', () => {
    const actions = '<FormActions submitLabel="s" />';
    expect(formSheetsWithBodyActions(`<FormSheet open={o}>${actions}</FormSheet>`)).toBe(1);
    expect(
      formSheetsWithBodyActions(`<FormSheet open={o} footer={null}>${actions}</FormSheet>`)
    ).toBe(1);
    expect(
      formSheetsWithBodyActions(`<FormSheet open={o} footer={${actions}}><p /></FormSheet>`)
    ).toBe(0);
  });

  test('CONTROL: the rule 13 scanners find what they forbid', () => {
    expect(formSheetsWithUnkeyedHeader("<FormSheet title={t('x')} description={group.name}>")).toBe(
      1
    );
    expect(
      formSheetsWithUnkeyedHeader("<FormSheet title={t('x')} description={t('y', { n })}>")
    ).toBe(0);
    expect(TEXT_CONTROL.test("import { Input } from '@scani/ui/ui/input';")).toBe(true);
    expect(
      TEXT_CONTROL.test("import { AmountInput } from '@scani/ui/v3/components/AmountInput';")
    ).toBe(true);
    expect(
      '<Pencil className="size-4" aria-hidden="true" />'.match(/<Pencil className="size-/g)?.length
    ).toBe(1);
    expect(
      '<Pencil className="me-2 size-4" aria-hidden="true" />'.match(/<Pencil className="size-/g)
    ).toBeNull();
  });

  test('CONTROL: each scanner finds a violation it is shown', () => {
    const bad = `<ConfirmAction label={t('x')} confirmLabel={t('x')} destructive onConfirm={go} />`;
    const good = `<ConfirmAction label={t('x')} confirmLabel={t('y')} destructive triggerClassName="text-destructive" onConfirm={go} />`;
    const [badTag] = confirmActionTags(bad);
    const [goodTag] = confirmActionTags(good);
    expect(propValue(badTag as string, 'label')).toBe(propValue(badTag as string, 'confirmLabel'));
    expect(propValue(goodTag as string, 'label')).not.toBe(
      propValue(goodTag as string, 'confirmLabel')
    );
    expect(/text-destructive/.test(badTag as string)).toBe(false);
    expect(/text-destructive/.test(goodTag as string)).toBe(true);
    expect(/\btoolbarAction\s*[:=]/.test('toolbarAction: { icon: Plus }')).toBe(true);
    expect(/from '@scani\/ui\/ui\/input'/.test("import { Input } from '@scani/ui/ui/input';")).toBe(
      true
    );
  });
});

/**
 * Rule 12, on the component itself: below 1024px a peek's actions are a
 * two-column grid of equal buttons, and a destructive one takes a full-width
 * row at the end. The layout is CSS, so what a markup test can hold is the
 * contract the CSS keys on — the grid classes, and the marker `ConfirmAction`
 * puts on a destructive or open confirm. The screenshots measure the rest.
 */
describe('rule 12: peek actions on phone (SC-1415)', () => {
  const noop = () => undefined;
  const confirm = (props: { label: string; destructive?: boolean; open?: boolean }) =>
    createElement(ConfirmAction, {
      label: props.label,
      confirmLabel: `Yes, ${props.label.toLowerCase()}`,
      consequence: 'What happens.',
      destructive: props.destructive,
      triggerClassName: props.destructive ? 'text-destructive hover:text-destructive' : undefined,
      open: props.open ?? false,
      onOpenChange: noop,
      onConfirm: noop,
    });
  const header = (actions: ReactNode) =>
    renderToStaticMarkup(
      createElement(
        Sheet,
        { open: true },
        createElement(PeekHeader, { spec: { title: 'Vodafone UK', primary: [], actions } })
      )
    );
  const row = (html: string) => {
    const m = html.match(/<div data-peek-actions="" class="([^"]*)">/);
    if (!m) throw new Error('no actions row in the peek header');
    return (m[1] as string).replaceAll('&amp;', '&').replaceAll('&gt;', '>');
  };

  test('the row is a two-column grid on phone and unchanged on desktop', () => {
    const cls = row(header(createElement(Button, null, 'Edit')));
    expect(cls.split(' ')).toContain('grid');
    expect(cls.split(' ')).toContain('grid-cols-2');
    expect(cls.split(' ')).toContain('lg:flex');
    expect(cls.split(' ')).toContain('lg:flex-wrap');
  });

  test('a destructive action is marked, and the row sends it last at full width', () => {
    const html = header(
      createElement(
        Fragment,
        null,
        confirm({ label: 'Delete', destructive: true }),
        createElement(Button, null, 'Edit'),
        confirm({ label: 'Pause' })
      )
    );
    const cls = row(html).split(' ');
    expect(cls).toContain('[&>[data-destructive]]:col-span-2');
    expect(cls).toContain('[&>[data-destructive]]:order-last');
    expect(cls).toContain('lg:[&>[data-destructive]]:order-none');
    // An odd last NORMAL action spans the row; destructives are not counted.
    expect(cls).toContain(
      '[&>:not([data-destructive]):nth-last-child(1_of_:not([data-destructive])):nth-child(odd_of_:not([data-destructive]))]:col-span-2'
    );
    expect(cls).not.toContain('[&>*:last-child:nth-child(odd)]:col-span-2');
    expect(html.match(/<button[^>]*data-destructive=""[^>]*>Delete</g)?.length).toBe(1);
    // Control: the reversible confirm and the plain button stay in the grid.
    expect(html).not.toMatch(/data-destructive=""[^>]*>Pause</);
    expect(html).not.toMatch(/data-destructive=""[^>]*>Edit</);
  });

  test('an open confirm takes the whole row, destructive or not', () => {
    const cls = row(header(confirm({ label: 'Pause', open: true }))).split(' ');
    expect(cls).toContain('[&>[data-confirm-open]]:col-span-2');
    expect(header(confirm({ label: 'Pause', open: true }))).toMatch(/<div data-confirm-open=""/);
    expect(header(confirm({ label: 'Delete', destructive: true, open: true }))).toMatch(
      /<div data-confirm-open="" data-destructive=""/
    );
  });
});
