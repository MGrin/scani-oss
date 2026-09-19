import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { SaltEdgeReturnPage } from '../../../src/v3/pages/SaltEdgeReturnPage';

const render = (search: string) =>
  renderToStaticMarkup(
    createElement(
      StaticRouter,
      { location: `/integrations/saltedge/return${search}` },
      createElement(SaltEdgeReturnPage)
    )
  );

describe('the Salt Edge return page (SC-1244)', () => {
  test('a clean return says the import runs in the background and points at Holdings', () => {
    const html = render('?connection_id=123');
    expect(html).toContain('Bank linked');
    expect(html).toContain('href="/holdings"');
  });

  test("a failed return names Salt Edge's reason and offers a retry", () => {
    const html = render('?error_class=InvalidCredentials');
    expect(html).toContain('wasn');
    expect(html).toContain('InvalidCredentials');
    expect(html).toContain('href="/integrations/saltedge"');
    expect(html).not.toContain('Bank linked');
  });

  test('its path is the one saltedge.startConnect sends Salt Edge back to', () => {
    const router = readFileSync(
      join(import.meta.dir, '../../../../../backend/api/src/presentation/routers/saltedge.ts'),
      'utf8'
    );
    const app = readFileSync(join(import.meta.dir, '../../../src/v3/V3App.tsx'), 'utf8');
    expect(router).toContain('/integrations/saltedge/return');
    expect(app).toContain('/saltedge/return`}');
  });
});
