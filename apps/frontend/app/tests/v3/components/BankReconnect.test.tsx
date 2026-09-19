import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import {
  type BankConnection,
  BankReconnectRows,
} from '../../../src/v3/components/capture/BankReconnectList';
import {
  BankReconnectLine,
  countNeedingReconnect,
} from '../../../src/v3/components/home/BankReconnectNotice';

const active = {
  connectionId: 'c1',
  status: 'active',
  lastError: null,
  needsReconnect: false,
};
const expired = {
  connectionId: 'c2',
  status: 'inactive',
  lastError: 'expired',
  needsReconnect: true,
};

describe('the Salt Edge bank list (SC-1244)', () => {
  const render = (connections: BankConnection[]) =>
    renderToStaticMarkup(
      createElement(BankReconnectRows, { connections, onReconnect: () => {}, pendingId: null })
    );

  test('an expired bank says it stopped syncing and offers Reconnect', () => {
    const html = render([active, expired]);
    expect(html).toContain('Syncing');
    expect(html).toContain('Needs reconnecting');
    expect(html.match(/>Reconnect</g)?.length).toBe(1);
  });

  test('with every bank active there is nothing to press', () => {
    expect(render([active])).not.toContain('>Reconnect<');
  });
});

describe('the Home notice for a bank that stopped syncing (SC-1244)', () => {
  test('counts only the banks that need reconnecting', () => {
    expect(countNeedingReconnect([active, expired, { ...expired, connectionId: 'c3' }])).toBe(2);
    expect(countNeedingReconnect(undefined)).toBe(0);
  });

  test('names the count and links to the Salt Edge page', () => {
    const html = renderToStaticMarkup(
      createElement(StaticRouter, { location: '/' }, createElement(BankReconnectLine, { count: 2 }))
    );
    expect(html).toContain('2 banks stopped syncing');
    expect(html).toContain('href="/integrations/saltedge"');
    expect(html).toContain('role="status"');
  });

  test('uses the singular for one bank', () => {
    const html = renderToStaticMarkup(
      createElement(StaticRouter, { location: '/' }, createElement(BankReconnectLine, { count: 1 }))
    );
    expect(html).toContain('1 bank stopped syncing');
  });
});
