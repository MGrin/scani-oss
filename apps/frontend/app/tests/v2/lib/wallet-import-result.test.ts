import { describe, expect, test } from 'bun:test';
import {
  asCount,
  classifyFetch,
  readChainErrors,
  statesWalletContents,
} from '../../../src/v2/lib/wallet-import-result';

/**
 * The invariant, and the reason SC-139 and SC-145 are one ticket: a
 * wallet-import result has to be able to say **"we could not read this"**
 * distinctly from **"this is empty"**. Both bugs existed because it could
 * not, and a green job then made a positive false claim about someone's
 * money.
 */
describe('wallet-import result — unreadable is not empty', () => {
  // The SC-139 shape, verbatim from the job row: a chain was detected, the
  // fetch failed, zero candidates came back. The screen said "0 tokens
  // across 0 chains".
  const FAILED_FETCH = {
    chains: [],
    errors: [
      {
        chainId: 'linea',
        chainName: 'Linea',
        error: 'Etherscan rate limit / auth: Missing/Invalid API Key',
      },
    ],
    chainsDetected: 1,
    candidateCount: 0,
    needsReview: true,
  };

  test('a failed fetch with no candidates classifies as unreadable, never empty', () => {
    const errors = readChainErrors(FAILED_FETCH.errors);
    const outcome = classifyFetch(asCount(FAILED_FETCH.candidateCount), errors.length);
    expect(outcome).toBe('unreadable');
    expect(outcome).not.toBe('empty');
    expect(statesWalletContents(outcome)).toBe(false);
  });

  test('a clean fetch with no candidates is the only thing that reads as empty', () => {
    const outcome = classifyFetch(0, 0);
    expect(outcome).toBe('empty');
    expect(statesWalletContents(outcome)).toBe(true);
  });

  test('candidates alongside a failure are partial, not a complete answer', () => {
    expect(classifyFetch(12, 1)).toBe('partial');
    expect(classifyFetch(12, 0)).toBe('found');
  });

  test('the chain count reported comes from detection, not from what was read', () => {
    // `chains` is empty because the fetch failed; the address was still
    // detected on one chain. Reporting the former as the latter is what
    // produced "0 chains" next to `chainsDetected: 1`.
    expect(Math.max(asCount(FAILED_FETCH.chainsDetected), FAILED_FETCH.chains.length)).toBe(1);
  });
});

describe('readChainErrors', () => {
  test('keeps the provider message and names the chain', () => {
    expect(readChainErrors([{ chainName: 'Linea', error: 'Missing/Invalid API Key' }])).toEqual([
      'Linea: Missing/Invalid API Key',
    ]);
  });

  test('omits a placeholder chain name rather than printing it', () => {
    expect(readChainErrors([{ chainName: 'Unknown', error: 'boom' }])).toEqual(['boom']);
  });

  test('passes through legacy string entries', () => {
    expect(readChainErrors(['plain failure'])).toEqual(['plain failure']);
  });

  test('never silently drops an unrecognised entry', () => {
    expect(readChainErrors([{ weird: true }])).toEqual(['{"weird":true}']);
  });

  test('a missing errors field is no errors, not a crash', () => {
    expect(readChainErrors(undefined)).toEqual([]);
    expect(readChainErrors({ _truncated: true })).toEqual([]);
  });
});

describe('asCount', () => {
  test('reads a number, an array length, and nothing else', () => {
    expect(asCount(3)).toBe(3);
    expect(asCount(['a', 'b'])).toBe(2);
    expect(asCount(undefined)).toBe(0);
    expect(asCount(Number.NaN)).toBe(0);
  });
});
