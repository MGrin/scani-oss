import { describe, expect, test } from 'bun:test';
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubString,
} from '../../src/utils/sentry-scrubber';

describe('scrubString', () => {
  test('redacts email addresses', () => {
    expect(scrubString('contact alice@example.com for help')).toBe('contact <redacted> for help');
    expect(scrubString('a@b.co and c.d@e.f.gh')).toBe('<redacted> and <redacted>');
  });

  test('redacts JWT-shaped tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(scrubString(`token: ${jwt}`)).toBe('token: <redacted>');
  });

  test('redacts authorization header values', () => {
    expect(scrubString('Authorization: Bearer abc.def.ghi')).toBe(
      'Authorization: Bearer <redacted>'
    );
    expect(scrubString('authorization: token sk-live-1234567890abcdef')).toBe(
      'authorization: token <redacted>'
    );
  });

  test('leaves benign strings unchanged', () => {
    expect(scrubString('Failed to fetch portfolio')).toBe('Failed to fetch portfolio');
    expect(scrubString('user clicked dashboard')).toBe('user clicked dashboard');
    expect(scrubString('')).toBe('');
  });
});

describe('scrubSentryEvent', () => {
  test('walks nested string fields', () => {
    const event = {
      message: 'failed for bob@example.com',
      extra: {
        url: 'https://api.example.com/?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
        nested: ['contact c@d.com'],
      },
    };
    scrubSentryEvent(event);
    expect(event.message).toBe('failed for <redacted>');
    expect(event.extra.url).toContain('<redacted>');
    expect(event.extra.nested[0]).toBe('contact <redacted>');
  });

  test('handles cycles without spinning', () => {
    interface SelfRef {
      kind: string;
      message: string;
      self?: SelfRef;
    }
    const event: SelfRef = { kind: 'error', message: 'see x@y.com' };
    event.self = event;
    expect(() => scrubSentryEvent(event)).not.toThrow();
    expect(event.message).toBe('see <redacted>');
  });

  test('null / undefined are passed through', () => {
    expect(scrubSentryEvent(null)).toBeNull();
    expect(scrubSentryEvent(undefined)).toBeUndefined();
  });

  test('numeric / boolean leaves unchanged', () => {
    const event = { count: 5, ok: true, msg: 'a@b.co' };
    scrubSentryEvent(event);
    expect(event.count).toBe(5);
    expect(event.ok).toBe(true);
    expect(event.msg).toBe('<redacted>');
  });
});

describe('scrubSentryBreadcrumb', () => {
  test('redacts strings inside the breadcrumb', () => {
    const crumb = {
      category: 'fetch',
      message: 'GET /api/users for bob@example.com',
      data: { headers: 'Authorization: Bearer abc.def.ghi' },
    };
    scrubSentryBreadcrumb(crumb);
    expect(crumb.message).toBe('GET /api/users for <redacted>');
    expect(crumb.data.headers).toBe('Authorization: Bearer <redacted>');
  });
});
