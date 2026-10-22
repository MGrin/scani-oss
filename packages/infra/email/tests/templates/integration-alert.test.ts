import { describe, expect, test } from 'bun:test';
import { renderIntegrationAlertEmail, type StaleIntegrationItem } from '../../src/templates';
import { SCANI_BRAND } from '../../src/types';

const ALERTS_UNSUB = 'https://api.scani.xyz/e/a/8b1f1a2e-0000-4000-8000-000000000000';
const DIGEST_UNSUB = 'https://api.scani.xyz/e/u/8b1f1a2e-0000-4000-8000-000000000000';

const render = (integrations: StaleIntegrationItem[], language?: string | null) =>
  renderIntegrationAlertEmail({
    brand: SCANI_BRAND,
    name: 'Alice Example',
    language,
    integrations,
    integrationsUrl: 'https://app.scani.xyz/integrations',
    unsubscribeUrl: ALERTS_UNSUB,
    digestUnsubscribeUrl: DIGEST_UNSUB,
  });

const KRAKEN: StaleIntegrationItem = { name: 'Kraken', reason: 'stopped' };
const WISE: StaleIntegrationItem = { name: 'Wise', reason: 'never-synced' };

describe('renderIntegrationAlertEmail (SC-459)', () => {
  // mx.yandex.ru refused "Scani: Bybit is not syncing" as spam (SC-1721): an
  // exchange's name in the subject over a "Reconnect" link is the shape of
  // credential phishing. The body still names the connection.
  test('the subject names no connection', () => {
    expect(render([KRAKEN]).subject).toBe('Scani: a connection needs attention');
    expect(render([KRAKEN, WISE]).subject).toBe('Scani: a connection needs attention');
    expect(render([KRAKEN]).text).toContain('Kraken');
  });

  test('the call to action names the page, not "Reconnect"', () => {
    const out = render([KRAKEN]);
    expect(out.text).not.toMatch(/reconnect:/i);
    expect(out.html).not.toMatch(/>\s*Reconnect/);
    expect(out.text).toContain(
      'Open Integrations in Scani to update it: https://app.scani.xyz/integrations'
    );
    expect(out.html).toContain('Open Integrations');
  });

  test('it carries one-click unsubscribe headers for the alerts stream (RFC 8058)', () => {
    expect(render([KRAKEN]).headers).toEqual({
      'List-Unsubscribe': `<${ALERTS_UNSUB}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  test("it is written in the reader's language", () => {
    const out = render([KRAKEN], 'ru-RU');
    expect(out.subject).toBe('Scani: подключение требует внимания');
    expect(out.text).toContain('Kraken');
    expect(out.html).toContain('lang="ru"');
  });

  test('control: a language we cannot write in gets the English letter', () => {
    expect(render([KRAKEN], 'xx').subject).toBe('Scani: a connection needs attention');
  });

  test('the unsubscribe link is in both bodies', () => {
    // Same guardrail as the digest: an unsubscribe that exists only in the HTML
    // is missing from every plain-text client, and a reader who cannot find one
    // reports the mail as spam instead.
    const out = render([KRAKEN]);
    expect(out.html).toContain(ALERTS_UNSUB);
    expect(out.text).toContain(ALERTS_UNSUB);
  });

  test('the footer offers the other stream too, because "unsubscribe" usually means all of it', () => {
    expect(render([KRAKEN]).html).toContain(DIGEST_UNSUB);
  });

  test('the plural letter reads as plural in the text body too', () => {
    // The HTML branched and the text did not, so a two-connection alert said
    // "Until it is reconnected" — caught by reading the letter in Mailpit,
    // which no type-check or template test would have found.
    expect(render([KRAKEN, WISE]).text).toContain('Until they are reconnected');
    expect(render([KRAKEN]).text).toContain('Until it is reconnected');
  });

  test('the letter states the CONSEQUENCE, not just the event', () => {
    // "Kraken is not syncing" is a fact about our infrastructure. The reason a
    // reader should act is that the numbers they are looking at are wrong.
    const out = render([KRAKEN]);
    expect(out.text).toContain('do not include anything that has happened there since');
    expect(out.html).toContain('do not include anything that has happened there since');
  });

  test('the reconnect link goes to the page where it is fixed', () => {
    const out = render([KRAKEN]);
    expect(out.html).toContain('<a href="https://app.scani.xyz/integrations"');
    expect(out.text).toContain('https://app.scani.xyz/integrations');
  });

  test('a connection that never synced reads differently from one that stopped', () => {
    // They need different actions: one was never finished, the other broke.
    const out = render([WISE]);
    expect(out.text).toContain('nothing has ever come through');
    expect(render([KRAKEN]).text).toContain('has stopped sending updates');
  });

  test('an institution name is escaped rather than rendered', () => {
    // `institutions.name` is user-supplied — the import flow lets anyone add
    // "Add <name>" to a shared catalogue (SC-135).
    const out = render([{ name: '<img src=x onerror=alert(1)>', reason: 'stopped' }]);
    expect(out.html).not.toContain('<img src=x');
    expect(out.html).toContain('&lt;img src=x');
  });
});
