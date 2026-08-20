import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import v3En from '../../../src/v3/i18n/locales/en.json';
import v3Ru from '../../../src/v3/i18n/locales/ru.json';
import { connectErrorCopy } from '../../../src/v3/lib/connect-error';

const t = i18n.t.bind(i18n) as (key: string, vars?: Record<string, unknown>) => string;

/** What the page renders: the two halves joined, exactly as `ConnectForm` does. */
function sentence(translate: typeof t, error: unknown, institutionName: string): string {
  const copy = connectErrorCopy(translate, error, institutionName);
  return `${copy.title}. ${copy.detail}`;
}

/** What a tRPC client error looks like to the copy layer: an envelope, not a
 *  message we pattern-match. */
function trpcError(httpStatus: number, message: string): unknown {
  return { message, data: { httpStatus } };
}

/**
 * "We couldn't check" is a different sentence from "you were rejected"
 * (SC-445).
 *
 * The connect form had one failure sentence and `describeQueryError`'s 400
 * branch produced it for everything: "Couldn't connect Kraken. <reason>. Your
 * data is untouched." That is right for a refused key and wrong for a venue
 * that was down — and the reader acts on it, by reissuing credentials that
 * were never the problem.
 */
describe('connectErrorCopy', () => {
  test('a rejection keeps the provider’s own reason', () => {
    const text = sentence(t, trpcError(400, 'Kraken: EAPI:Invalid key'), 'Kraken');
    expect(text).toContain('EAPI:Invalid key');
    expect(text).toContain('Kraken');
  });

  test('a 5xx says the check did not happen, and claims nothing about the keys', () => {
    const text = sentence(
      t,
      trpcError(500, "Couldn't reach Kraken to check these credentials"),
      'Kraken'
    );
    expect(text).toBe(
      "Couldn't check your Kraken keys. Kraken didn't answer, so we can't say whether the keys are right. Nothing was saved — try again in a minute."
    );
  });

  test('a timeout takes the same branch — an unanswered check is an unanswered check', () => {
    const text = sentence(t, trpcError(408, 'Kraken took too long to answer'), 'Kraken');
    expect(text).toContain("Couldn't check your Kraken keys");
  });

  test('a rate limit keeps its own copy — it already claims nothing about the keys', () => {
    const text = sentence(t, trpcError(429, 'slow down'), 'Interactive Brokers');
    expect(text).not.toContain("Couldn't check your");
    expect(text).toMatch(/too many requests/i);
  });

  test('offline keeps the offline copy', () => {
    const text = sentence(t, new TypeError('Failed to fetch'), 'Wise');
    expect(text).not.toContain("Couldn't check your");
  });

  test('both locales answer the new keys', () => {
    for (const bundle of [v3En, v3Ru]) {
      const integration = (
        bundle as unknown as {
          v3: { capture: { integration: Record<string, string> } };
        }
      ).v3.capture.integration;
      expect(integration.unverifiedTitle).toContain('{{name}}');
      expect(integration.unverifiedDetail).toContain('{{name}}');
    }
  });
});
