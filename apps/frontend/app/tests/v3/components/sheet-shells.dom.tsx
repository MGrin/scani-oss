import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { CaptureSheet } from '@/v3/components/capture/CaptureSheet';
import { FormSheet } from '@/v3/components/form/FormSheet';
import {
  mountForViewport,
  OTHER_VIEWPORT,
  SHELL_OVERLAY,
  type Viewport,
} from '../../../../../../packages/frontend/ui/tests/helpers/mount-dom';

/**
 * Which shell wraps the app's two sheets, on each branch (SC-801). Both are
 * portals on both branches, so nothing short of mounting them can tell the
 * desktop `Sheet` from the phone `BottomDrawer`. Runs in the DOM process
 * `packages/frontend/ui/tests/helpers/dom-specs.ts` starts.
 */

const VIEWPORTS: Viewport[] = ['desktop', 'phone'];

const CASES: Record<string, { node: () => ReactElement; content: () => string }> = {
  CaptureSheet: {
    node: () => (
      <MemoryRouter>
        <CaptureSheet open onOpenChange={() => {}} />
      </MemoryRouter>
    ),
    content: () => i18n.t('v3.capture.sheet.title'),
  },
  FormSheet: {
    node: () => (
      <FormSheet
        open
        onOpenChange={() => {}}
        title="Rename vault"
        description="Changes the name everywhere it is shown."
      >
        <input aria-label="Name" />
      </FormSheet>
    ),
    content: () => 'Rename vault',
  },
};

describe('the app sheets, mounted', () => {
  for (const [name, { node, content }] of Object.entries(CASES)) {
    for (const viewport of VIEWPORTS) {
      test(`${name} draws the ${viewport} shell on the ${viewport} branch`, async () => {
        const html = await mountForViewport(node(), viewport);
        expect(html).toContain(SHELL_OVERLAY[viewport]);
        expect(html).not.toContain(SHELL_OVERLAY[OTHER_VIEWPORT[viewport]]);
        expect(html).toContain(content());
      });
    }
  }
});
