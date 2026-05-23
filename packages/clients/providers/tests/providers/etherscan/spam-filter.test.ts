import { describe, expect, test } from 'bun:test';
import { isLikelySpamToken } from '../../../src/providers/etherscan/spam-filter';

describe('isLikelySpamToken', () => {
  test.each([
    { name: 'Reward Token', symbol: 'RWD' },
    { name: 'Visit airdrop.com to claim', symbol: 'X' },
    { name: 'Normal Name', symbol: '$SCAM' },
    { name: 'Join t.me/foo', symbol: 'T' },
    { name: 'Swap USDC on Uniswap', symbol: 'SWP' },
    { name: 'Claim 1000 USDT on x.io', symbol: 'CLM' },
    { name: '<script>', symbol: 'X' },
    { name: 'Plain', symbol: 'A.io' },
  ])('flags suspicious token %o', (token) => {
    expect(isLikelySpamToken(token)).toBe(true);
  });

  test.each([
    { name: 'USD Coin', symbol: 'USDC' },
    { name: 'Wrapped Ether', symbol: 'WETH' },
    { name: 'Bitcoin', symbol: 'BTC' },
  ])('passes through legitimate token %o', (token) => {
    expect(isLikelySpamToken(token)).toBe(false);
  });

  test('runs in linear time on pathological "swap" repetition (ReDoS guard)', () => {
    // Regression test for the bounded `(?:swap|claim).{0,256}on` regex
    // (CodeQL js/polynomial-redos). The pre-fix `swap.*on|claim.*on`
    // with greedy `.*` had O(n²) backtracking on many 'swap' segments
    // that never terminate with 'on'; the bounded variant is linear.
    const name = 'swap'.repeat(10_000);
    const start = performance.now();
    const verdict = isLikelySpamToken({ name, symbol: 'X' });
    const elapsed = performance.now() - start;
    expect(verdict).toBe(false);
    expect(elapsed).toBeLessThan(500);
  });
});
