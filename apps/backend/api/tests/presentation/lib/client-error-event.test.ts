import { describe, expect, test } from 'bun:test';
import { clientErrorEvent, withoutQuery } from '../../../src/presentation/lib/client-error-event';

/**
 * SC-1333: a browser's error report reached only the api's stdout, which Fly
 * keeps for minutes. It now goes to Sentry too, and this is the shape it takes.
 */
describe('clientErrorEvent', () => {
  test('carries the message, and the stack where Sentry keeps it', () => {
    const event = clientErrorEvent(
      {
        message: 'Cannot read properties of undefined',
        stack: 'TypeError: Cannot read…\n    at Hero (index.js:1:2)',
        componentStack: '\n    at Hero\n    at Home',
        route: '/holdings?tokenType=crypto',
        userAgent: 'Mozilla/5.0',
        appVersion: '0.41.2',
      },
      'user-1'
    );
    expect(event.message).toBe('[client] Cannot read properties of undefined');
    expect(event.level).toBe('error');
    expect(event.tags).toEqual({
      source: 'client',
      route: '/holdings',
      appVersion: '0.41.2',
    });
    expect(event.extra).toEqual({
      stack: 'TypeError: Cannot read…\n    at Hero (index.js:1:2)',
      componentStack: '\n    at Hero\n    at Home',
      userAgent: 'Mozilla/5.0',
    });
    // No query string reaches Sentry: it can carry a token (SC-1350).
    expect(JSON.stringify(event)).not.toContain('tokenType=crypto');
    expect(event.userId).toBe('user-1');
  });

  test('a signed-out report still has a shape, and no tag holds undefined', () => {
    const event = clientErrorEvent({ message: 'boom' }, null);
    expect(event.tags).toEqual({ source: 'client' });
    expect(event.extra).toEqual({});
    expect(event.userId).toBeNull();
  });

  test('a chunk that would not load is filed as a warning, under a [client] title (SC-1380)', () => {
    const event = clientErrorEvent(
      { message: 'Could not load the interface. Check your connection…', level: 'warning' },
      null
    );
    expect(event.level).toBe('warning');
    expect(event.message).toBe('[client] Could not load the interface. Check your connection…');
  });
});

/**
 * SC-1350: a query string can carry a magic-link token, and the route goes to
 * the logs and Sentry. A tab loaded before the app stopped sending it still
 * does, so the api strips it too. The plain path is the control.
 */
describe('withoutQuery', () => {
  test('drops the query string and the fragment', () => {
    expect(withoutQuery('/auth/verify?token=abc123')).toBe('/auth/verify');
    expect(withoutQuery('/holdings#top')).toBe('/holdings');
    expect(withoutQuery('/x?a=1#b')).toBe('/x');
  });

  test('CONTROL: a plain path and a missing route pass through unchanged', () => {
    expect(withoutQuery('/holdings')).toBe('/holdings');
    expect(withoutQuery(undefined)).toBeUndefined();
  });
});
