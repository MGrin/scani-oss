import { describe, expect, test } from 'bun:test';
import {
  counterpartyFromPayload,
  explorerLinks,
  txHashFromPayload,
} from '../../src/lib/block-explorer';

/**
 * The transfer review queue asks "did this leave your portfolio?" about a row
 * whose only marks are an amount and a date. mgrin's answer to 560 of them was
 * that he could not remember. The address it went to and the transaction on a
 * block explorer are what make one identifiable, and both were already in the
 * row (SC-346).
 */
const OUT = { from: '0xmine', to: '0xtheirs', hash: `0x${'a'.repeat(64)}` };
const IN = { from: '0xtheirs', to: '0xmine', hash: `0x${'b'.repeat(64)}` };

describe('explorerLinks', () => {
  test('builds both links for the chains in production', () => {
    for (const [chainId, root] of [
      [1, 'https://etherscan.io'],
      [10, 'https://optimistic.etherscan.io'],
      [137, 'https://polygonscan.com'],
      [8453, 'https://basescan.org'],
    ] as const) {
      const links = explorerLinks('etherscan', chainId, '0xdead', '0xbeef');
      expect(links.transactionUrl).toBe(`${root}/tx/0xdead`);
      expect(links.addressUrl).toBe(`${root}/address/0xbeef`);
    }
  });

  test('non-EVM sources are keyed by source, not by a chainId sentinel', () => {
    // `accounts.metadata.chainId` is -2 for Solana and 0 for Bitcoin. Those
    // are an internal encoding, and keying public URLs on them would be a
    // coincidence waiting to break.
    expect(explorerLinks('solana', -2, 'sig', 'acct').transactionUrl).toBe(
      'https://solscan.io/tx/sig'
    );
    expect(explorerLinks('bitcoin', 0, 'txid', 'addr').addressUrl).toBe(
      'https://mempool.space/address/addr'
    );
  });

  test('an unknown chain yields nulls rather than a guessed root', () => {
    // A wrong explorer link is worse than none: it reads as authoritative and
    // lands the reader on a page saying the transaction does not exist, which
    // is the exact doubt this feature removes.
    expect(explorerLinks('etherscan', 999999, '0xdead', '0xbeef')).toEqual({
      transactionUrl: null,
      addressUrl: null,
    });
    expect(explorerLinks('kraken-api', null, null, null).transactionUrl).toBeNull();
  });

  test('a missing hash or address nulls only that half', () => {
    const noAddress = explorerLinks('etherscan', 1, '0xdead', null);
    expect(noAddress.transactionUrl).toBe('https://etherscan.io/tx/0xdead');
    expect(noAddress.addressUrl).toBeNull();
  });
});

describe('counterpartyFromPayload', () => {
  test('the stored column wins when it has been filled', () => {
    // The nightly backfill (SC-329) is authoritative once it has run; this
    // read-time fallback exists only for rows it has not reached yet.
    expect(counterpartyFromPayload('transfer_out', OUT, '0xstored')).toBe('0xstored');
  });

  test('an outflow names the destination, an inflow the sender', () => {
    expect(counterpartyFromPayload('transfer_out', OUT, null)).toBe('0xtheirs');
    expect(counterpartyFromPayload('withdraw', OUT, null)).toBe('0xtheirs');
    expect(counterpartyFromPayload('transfer_in', IN, null)).toBe('0xtheirs');
    expect(counterpartyFromPayload('deposit', IN, null)).toBe('0xtheirs');
  });

  test('an unknown kind returns null rather than picking a side', () => {
    // Pointing the wrong way says the user paid themselves, which reads as a
    // confirmed internal move — worse than saying nothing.
    expect(counterpartyFromPayload('something_new', OUT, null)).toBeNull();
  });

  test('it is total — a hostile payload never throws', () => {
    for (const raw of [null, undefined, 42, 'a string', [], { to: 5 }, { to: '   ' }]) {
      expect(() => counterpartyFromPayload('transfer_out', raw, null)).not.toThrow();
      expect(counterpartyFromPayload('transfer_out', raw, null)).toBeNull();
    }
  });
});

describe('txHashFromPayload', () => {
  test('prefers the payload hash', () => {
    expect(txHashFromPayload(OUT, null)).toBe(OUT.hash);
  });

  test('falls back to the leading hash in a lossy external_id', () => {
    // `external_id` is `hash-contract` for ERC-20 rows — the key whose
    // missing log index is SC-341.
    const hash = `0x${'c'.repeat(64)}`;
    expect(txHashFromPayload(null, `${hash}-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`)).toBe(
      hash
    );
    expect(txHashFromPayload(null, hash)).toBe(hash);
  });

  test('returns null for an external_id that is not a hash', () => {
    // Exchange rows use their own ids; inventing a chain link for one would
    // send the reader to an explorer that has never heard of it.
    expect(txHashFromPayload(null, 'kraken-ledger-12345')).toBeNull();
    expect(txHashFromPayload(null, null)).toBeNull();
  });
});
