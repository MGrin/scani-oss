import { describe, expect, test } from 'bun:test';
import { addUiLocale } from '@scani/ui/i18n';
import { ExportSheet } from '@scani/ui/v3/components/data-view/ExportSheet';
import { RefineSheet } from '@scani/ui/v3/components/data-view/RefineSheet';
import { PeekSheet } from '@scani/ui/v3/components/PeekSheet';
import type { ReactElement } from 'react';
import {
  mountForViewport,
  OTHER_VIEWPORT,
  SHELL_OVERLAY,
  type Viewport,
} from '../../helpers/mount-dom';

/**
 * Which shell wraps each of the three `@scani/ui` sheets, on each branch
 * (SC-801). Mounted, in the DOM process `dom-specs.ts` starts, because every
 * one of them is a portal on both branches and renders nothing under
 * `renderToStaticMarkup`. Their contents are covered next door through the
 * exported halves; the shells were covered by nothing.
 *
 * Every case asserts the shell's own overlay, the absence of the other one's,
 * and a piece of content — so a sheet that stopped branching, or stopped
 * rendering its body, fails rather than passing under either name.
 */

addUiLocale('en', { ui: { dataView: { test: { value: 'Value' } } } });

const VIEWPORTS: Viewport[] = ['desktop', 'phone'];

const CASES: Record<string, { node: ReactElement; content: string }> = {
  PeekSheet: {
    node: (
      <PeekSheet
        open
        onOpenChange={() => {}}
        noun="holding"
        spec={{ title: 'wstETH', subtitle: 'Wrapped Staked Ether · Kraken', primary: [] }}
      />
    ),
    content: 'Wrapped Staked Ether · Kraken',
  },
  RefineSheet: {
    node: (
      <RefineSheet
        open
        onOpenChange={() => {}}
        nounKey="holdings"
        filters={{}}
        onSetFilter={() => {}}
        sortField="value"
        sortDirection="desc"
        sortDefs={[{ key: 'value', labelKey: 'ui.dataView.test.value' }]}
        onSetSort={() => {}}
        groupBy=""
        onSetGroupBy={() => {}}
        hasActiveFilters={false}
        onClearFilters={() => {}}
        filteredCount={12}
      />
    ),
    content: 'Value',
  },
  ExportSheet: {
    node: (
      <ExportSheet
        open
        onOpenChange={() => {}}
        subject="holdings"
        scopes={[{ key: 'all', label: 'All 69 holdings' }]}
        actionLabel={() => 'Export 69 holdings'}
        onExport={async () => {}}
      />
    ),
    content: 'Export 69 holdings',
  },
};

describe('the @scani/ui sheets, mounted', () => {
  for (const [name, { node, content }] of Object.entries(CASES)) {
    for (const viewport of VIEWPORTS) {
      test(`${name} draws the ${viewport} shell on the ${viewport} branch`, async () => {
        const html = await mountForViewport(node, viewport);
        expect(html).toContain(SHELL_OVERLAY[viewport]);
        expect(html).not.toContain(SHELL_OVERLAY[OTHER_VIEWPORT[viewport]]);
        expect(html).toContain(content);
      });
    }
  }
});
