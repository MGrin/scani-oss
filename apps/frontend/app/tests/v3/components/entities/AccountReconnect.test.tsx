import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AccountReconnect } from '../../../../src/v3/components/entities/AccountReconnect';
import en from '../../../../src/v3/i18n/locales/en.json';
import {
  keyRejectedLabels,
  keyRejectedNotice,
  lastSyncColumn,
  lastSyncFact,
  reconnectHref,
} from '../../../../src/v3/lib/accounts';

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

  test("the account's badge says what its owner has to do (SC-1728)", () => {
    expect(en.v3.entities.account.keyRejected).toBe('Needs reconnecting');
  });

  test('with no provider to name, it links to the integrations list', () => {
    expect(render(null)).toInclude('href="/integrations"');
  });

  // SC-1733: a Fio token lasts at most 180 days. When Fio refuses it, the
  // account names the cause and the cure (design).
  test('an expiring token that was refused reads "Token expired" and "Add a new token"', () => {
    const t = i18n.t.bind(i18n);
    const labels = keyRejectedLabels(t, {
      providerKey: 'fio',
      credentialNoun: 'token',
      credentialLifetimeDays: 180,
    });
    expect(labels).toEqual({ badge: 'Token expired', action: 'Add a new token' });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AccountReconnect providerKey="fio" label={labels.action} />
      </MemoryRouter>
    );
    expect(html).toInclude('Add a new token');
    expect(html).toInclude('href="/integrations/fio"');
  });

  test('CONTROL: a refused key that does not expire keeps the reconnect wording', () => {
    const t = i18n.t.bind(i18n);
    expect(
      keyRejectedLabels(t, {
        providerKey: 'bybit',
        credentialNoun: 'key',
        credentialLifetimeDays: null,
      })
    ).toEqual({ badge: 'Needs reconnecting', action: 'Key rejected — Reconnect' });
    expect(keyRejectedLabels(t, { providerKey: null })).toEqual({
      badge: 'Needs reconnecting',
      action: 'Key rejected — Reconnect',
    });
  });

  // Design: someone who opens the sheet from a link never sees the badge.
  test('the sheet says why an expiring token was refused, and how long one lasts', () => {
    const t = i18n.t.bind(i18n);
    const fio = {
      providerKey: 'fio',
      credentialNoun: 'token' as const,
      credentialLifetimeDays: 180,
    };
    expect(keyRejectedNotice(t, fio, 'Fio banka')).toBe(
      'Fio banka stopped accepting this token. Fio banka tokens last up to 180 days.'
    );
    expect(
      keyRejectedNotice(t, { providerKey: 'bybit', credentialLifetimeDays: null }, 'Bybit')
    ).toBeNull();
  });

  // Design: "maintained by hand" beside "Add a new token" contradicts it. An
  // account with a credential behind it is not kept by hand.
  test('an account with a credential and no sync yet does not claim to be kept by hand', () => {
    const t = i18n.t.bind(i18n);
    const connected = { metadata: {}, keyRejected: { providerKey: 'fio' } };
    expect(lastSyncFact(t, connected)).toBe('Never — this connection has not synced yet');
    expect(lastSyncFact(t, { metadata: {}, keyRejected: null })).toBe(
      'Never — this account is maintained by hand'
    );
    expect(lastSyncColumn(t, connected)).toBe('Not synced yet');
    expect(lastSyncColumn(t, { metadata: {}, keyRejected: null })).toBe('By hand');
  });

  test('reconnectHref escapes the key', () => {
    expect(reconnectHref('a b')).toBe('/integrations/a%20b');
    expect(reconnectHref(null)).toBe('/integrations');
  });
});
