import { describe, expect, test } from 'bun:test';
import {
  isIgnoredSentryMessage,
  isThirdPartyOnlyStack,
  SENTRY_IGNORED_ERROR_PATTERNS,
} from '../../src/utils/sentry-noise';

describe('isIgnoredSentryMessage — aborted fetches', () => {
  // SCANI-FRONTEND-8: 17 events / 4 users over two months, all mobile
  // Chromium. The breadcrumbs show the preceding tRPC calls returning 200,
  // so the connection was alive and then went away mid-request.
  test('drops the Chromium/Android wording', () => {
    expect(isIgnoredSentryMessage('Failed to fetch')).toBe(true);
    expect(isIgnoredSentryMessage('TypeError: Failed to fetch')).toBe(true);
  });

  test('drops the Safari/iOS wording', () => {
    expect(isIgnoredSentryMessage('Load failed')).toBe(true);
    expect(isIgnoredSentryMessage('TypeError: Load failed')).toBe(true);
  });

  test('drops the Firefox wording', () => {
    expect(isIgnoredSentryMessage('NetworkError when attempting to fetch resource.')).toBe(true);
  });

  test('drops the Safari cancelled-navigation wording', () => {
    expect(isIgnoredSentryMessage('cancelled')).toBe(true);
  });
});

describe('isIgnoredSentryMessage — must not swallow real errors', () => {
  // The whole point of this list is that real regressions stay visible.
  // These are the cases that make a blanket `/Failed to fetch/` wrong: an
  // app error that merely starts with the same words has to survive.
  test('keeps app errors that only look similar', () => {
    expect(isIgnoredSentryMessage('Failed to fetch portfolio')).toBe(false);
    expect(isIgnoredSentryMessage('Failed to fetch holdings for account 12')).toBe(false);
    expect(isIgnoredSentryMessage('Load failed for vault')).toBe(false);
  });

  test('keeps ordinary application errors', () => {
    expect(isIgnoredSentryMessage("Cannot read properties of undefined (reading 'id')")).toBe(
      false
    );
    expect(isIgnoredSentryMessage('UNAUTHORIZED')).toBe(false);
    expect(isIgnoredSentryMessage('Invariant violation: missing provider')).toBe(false);
    expect(isIgnoredSentryMessage('')).toBe(false);
  });

  test('keeps a genuine server failure surfaced through tRPC', () => {
    expect(isIgnoredSentryMessage('INTERNAL_SERVER_ERROR: pricing job failed')).toBe(false);
  });
});

describe('isIgnoredSentryMessage — pre-existing extension noise', () => {
  test('drops wallet-extension postEvent errors', () => {
    expect(isIgnoredSentryMessage('Error invoking postEvent: Method not found')).toBe(true);
  });

  test('drops ResizeObserver loop warnings', () => {
    expect(
      isIgnoredSentryMessage('ResizeObserver loop completed with undelivered notifications')
    ).toBe(true);
  });
});

describe('SENTRY_IGNORED_ERROR_PATTERNS', () => {
  test('is a non-empty list Sentry can consume directly', () => {
    expect(SENTRY_IGNORED_ERROR_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of SENTRY_IGNORED_ERROR_PATTERNS) {
      expect(typeof pattern === 'string' || pattern instanceof RegExp).toBe(true);
    }
  });

  test('regexes are stateless — no /g flag, which would alternate results', () => {
    // A /g regex keeps `lastIndex` between calls, so the same message would
    // match, then not match, then match again. Silent and maddening.
    for (const pattern of SENTRY_IGNORED_ERROR_PATTERNS) {
      if (pattern instanceof RegExp) expect(pattern.global).toBe(false);
    }
  });
});

describe('isThirdPartyOnlyStack', () => {
  const frame = (filename: string) => ({ filename, abs_path: filename });

  test('drops events whose every frame is an extension', () => {
    expect(
      isThirdPartyOnlyStack({
        exception: {
          values: [
            {
              stacktrace: {
                frames: [
                  frame('chrome-extension://abc/inject.js'),
                  frame('moz-extension://def/content.js'),
                ],
              },
            },
          ],
        },
      })
    ).toBe(true);
  });

  test('keeps events with at least one app frame', () => {
    expect(
      isThirdPartyOnlyStack({
        exception: {
          values: [
            {
              stacktrace: {
                frames: [
                  frame('chrome-extension://abc/inject.js'),
                  frame('https://app.scani.xyz/assets/index-abc.js'),
                ],
              },
            },
          ],
        },
      })
    ).toBe(false);
  });

  test('keeps events with no stack — absence of evidence is not evidence', () => {
    expect(isThirdPartyOnlyStack({})).toBe(false);
    expect(isThirdPartyOnlyStack({ exception: { values: [] } })).toBe(false);
    expect(isThirdPartyOnlyStack({ exception: { values: [{ stacktrace: { frames: [] } }] } })).toBe(
      false
    );
  });

  test('keeps events whose frames have no resolvable url', () => {
    // A frame with no filename tells us nothing; treating "unknown" as
    // third-party would drop real native/minified crashes.
    expect(
      isThirdPartyOnlyStack({
        exception: { values: [{ stacktrace: { frames: [{ filename: '' }] } }] },
      })
    ).toBe(false);
  });
});
