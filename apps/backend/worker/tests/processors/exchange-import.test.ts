import { describe, expect, it } from 'bun:test';
import { __test_isUnrecoverableExchangeError as classify } from '../../src/processors/exchange-import';

describe('isUnrecoverableExchangeError', () => {
  it('classifies IBKR Flex bad-token codes', () => {
    expect(classify(new Error('IBKR Flex Query error (code 1010): Invalid token'))).toBe(true);
    expect(classify(new Error('IBKR Flex Query error (code 1012): Expired token'))).toBe(true);
    expect(classify(new Error('IBKR Flex Query error (code 1018): Too many requests'))).toBe(true);
  });

  it('classifies IBKR Flex retry-exhausted transients as unrecoverable', () => {
    // 1001 surviving the provider's in-job poll budget means the Flex
    // Query template is structurally too heavy or IBKR's queue is stuck —
    // BullMQ-level retries would just re-issue SendRequest and worsen
    // the upstream backlog. Surface as terminal so the user can adjust
    // the query scope.
    expect(
      classify(
        new Error(
          'IBKR import failed: IBKR Flex Query error (code 1001): Statement could not be generated at this time. Please try again shortly.'
        )
      )
    ).toBe(true);
    expect(classify(new Error('IBKR report still generating after 24 retries (last: 1001)'))).toBe(
      true
    );
    expect(
      classify(new Error('IBKR SendRequest still transient after 6 retries (last: 1001)'))
    ).toBe(true);
  });

  it('classifies generic HTTP 401/403 across providers', () => {
    expect(classify(new Error('Bitstamp HTTP 401: Unauthorized'))).toBe(true);
    expect(classify(new Error('Alpaca HTTP 403: forbidden'))).toBe(true);
    expect(classify(new Error('Mercury HTTP 401'))).toBe(true);
  });

  it('classifies Bitfinex "apikey: invalid" in HTTP 5xx bodies', () => {
    const bitfinex500 = 'Bitfinex HTTP 500: ["error",10100,"apikey: invalid"]';
    expect(classify(new Error(bitfinex500))).toBe(true);
  });

  it('classifies bitbank success=0 error codes', () => {
    expect(classify(new Error('bitbank error code 20001'))).toBe(true);
    expect(classify(new Error('bitbank error code 20014'))).toBe(true);
  });

  it('classifies Tiger Brokers gateway errors', () => {
    expect(classify(new Error('Tiger Brokers error 40001: sign invalid'))).toBe(true);
    expect(classify(new Error('Tiger Brokers error 10010: account inactive'))).toBe(true);
  });

  it('classifies Zerodha login / 2FA / session-token flow failures', () => {
    expect(classify(new Error('Zerodha login failed: Invalid user_id or password'))).toBe(true);
    expect(classify(new Error('Zerodha 2FA failed: Invalid TOTP'))).toBe(true);
    expect(classify(new Error('Zerodha session/token failed: token_exchange error'))).toBe(true);
    expect(
      classify(new Error('Zerodha OAuth redirect produced no request_token after 8 hops'))
    ).toBe(true);
    expect(classify(new Error('Zerodha: TokenException — api_key/access_token invalid'))).toBe(
      true
    );
  });

  it('classifies blockchain-misroute errors', () => {
    expect(
      classify(new Error('No wallet manager available or missing userId in credentials'))
    ).toBe(true);
    expect(classify(new Error('Exchange-import targeted a blockchain-type institution'))).toBe(
      true
    );
  });

  it('treats transient errors as retriable', () => {
    expect(classify(new Error('fetch failed: ECONNRESET'))).toBe(false);
    expect(classify(new Error('Bitstamp HTTP 500: Internal Server Error'))).toBe(false);
    expect(classify(new Error('timeout'))).toBe(false);
  });
});
