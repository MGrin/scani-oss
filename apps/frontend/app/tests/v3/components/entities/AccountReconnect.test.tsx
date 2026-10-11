import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AccountReconnect } from '../../../../src/v3/components/entities/AccountReconnect';
import { reconnectHref } from '../../../../src/v3/lib/accounts';

const render = (providerKey: string | null) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <AccountReconnect providerKey={providerKey} />
    </MemoryRouter>
  );

describe('a rejected key asks its owner to reconnect (SC-1686)', () => {
  test("the prompt links to the provider's connect page", () => {
    const html = render('bybit');
    expect(html).toInclude('Key rejected — Reconnect');
    expect(html).toInclude('href="/integrations/bybit"');
  });

  test('with no provider to name, it links to the integrations list', () => {
    expect(render(null)).toInclude('href="/integrations"');
  });

  test('reconnectHref escapes the key', () => {
    expect(reconnectHref('a b')).toBe('/integrations/a%20b');
    expect(reconnectHref(null)).toBe('/integrations');
  });
});
