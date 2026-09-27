import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import pino from 'pino';
import { LOG_REDACT } from '../src/redact';

// SC-1350: pino had no `redact`, so a credential that reached a log line —
// `integrations.validateKeys` input at debug, a header — was written verbatim.

function capture(entry: Record<string, unknown>): string {
  let out = '';
  const sink = new Writable({
    write(chunk, _enc, done) {
      out += chunk.toString();
      done();
    },
  });
  pino({ redact: LOG_REDACT }, sink).info(entry, 'probe');
  return out;
}

describe('LOG_REDACT', () => {
  test.each([
    ['a top-level key', { apiKey: 'SECRET-1' }],
    ['a nested credential object', { input: { credentials: { apiKey: 'SECRET-1' } } }],
    ['an api secret two levels down', { input: { exchange: { apiSecret: 'SECRET-1' } } }],
    ['a password', { input: { password: 'SECRET-1' } }],
    ['an authorization header', { headers: { authorization: 'Bearer SECRET-1' } }],
    ['a cookie header', { req: { headers: { cookie: 'session=SECRET-1' } } }],
  ])('censors %s', (_label, entry) => {
    const line = capture(entry);
    expect(line).not.toContain('SECRET-1');
    expect(line).toContain('[redacted]');
  });

  test('control: ordinary fields are logged as they are', () => {
    const line = capture({ input: { symbol: 'AAPL', limit: 10 } });
    expect(line).toContain('AAPL');
    expect(line).not.toContain('[redacted]');
  });
});
