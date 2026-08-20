import { describe, expect, test } from 'bun:test';
import { extractCounterparty } from '../../src/core/counterparty';

/**
 * A chain transfer names the address on the other side of it, and until
 * SC-329 nothing read it: all 385 `etherscan` rows in production carried
 * `to` and `from` in their payload and a NULL `counterparty`, while the
 * transfer review queue rendered that empty column under the label "to".
 * That queue's entire question is where the money went, and the answer was
 * sitting one field away in the row it was asking about.
 *
 * The direction is the whole difficulty. For an outflow the counterparty is
 * the destination; for an inflow it is the sender; and picking wrong is worse
 * than picking nothing, because it tells the reader they paid themselves.
 */
const OUT = { from: '0xmine', to: '0xtheirs', hash: '0xabc', value: '1000' };
const IN = { from: '0xtheirs', to: '0xmine', hash: '0xdef', value: '1000' };

describe('etherscan counterparty', () => {
  test('an outflow names the destination', () => {
    for (const kind of ['transfer_out', 'withdraw', 'swap_out', 'sell']) {
      expect(extractCounterparty('etherscan', OUT, kind).counterparty).toBe('0xtheirs');
    }
  });

  test('an inflow names the sender', () => {
    for (const kind of ['transfer_in', 'deposit', 'swap_in', 'buy', 'airdrop']) {
      expect(extractCounterparty('etherscan', IN, kind).counterparty).toBe('0xtheirs');
    }
  });

  test('an unknown kind yields nothing rather than guessing a direction', () => {
    // The one case where returning a value would be actively harmful: a
    // counterparty pointing the wrong way says the user sent funds to
    // themselves, which reads as a confirmed internal move.
    expect(extractCounterparty('etherscan', OUT, 'something_new')).toEqual({});
    expect(extractCounterparty('etherscan', OUT)).toEqual({});
  });

  test('no description is set — an address is not prose', () => {
    // `to` is a 42-character hex string. Rendering it as the description too
    // would print the same address twice on one row.
    expect(extractCounterparty('etherscan', OUT, 'transfer_out').description).toBeUndefined();
  });

  test('a payload missing the side it needs yields nothing, not undefined-as-text', () => {
    expect(extractCounterparty('etherscan', { from: '0xmine' }, 'transfer_out')).toEqual({});
    expect(extractCounterparty('etherscan', { to: '0xmine' }, 'transfer_in')).toEqual({});
    expect(extractCounterparty('etherscan', { from: '   ' }, 'transfer_in')).toEqual({});
  });

  test('it is total — a hostile payload never throws', () => {
    // The backfill sweeps every historical row unattended; one thrown
    // extractor must not abort the batch.
    for (const raw of [null, undefined, 42, 'a string', [], { to: 5 }]) {
      expect(() => extractCounterparty('etherscan', raw, 'transfer_out')).not.toThrow();
    }
  });

  test('EXCHANGE trades are still skipped, which was always correct', () => {
    // The docstring's old claim swept chain transfers in with exchange
    // trades. Only the second half of it was true, and it stays true.
    for (const source of ['kraken-api', 'bybit-api', 'ibkr-api', 'solana']) {
      expect(extractCounterparty(source, OUT, 'transfer_out')).toEqual({});
    }
  });

  test('the ledger sources ignore kind entirely', () => {
    const airwallex = { id: 'x', description: 'ACME Ltd' };
    expect(extractCounterparty('airwallex-api', airwallex).counterparty).toBe('ACME Ltd');
    expect(extractCounterparty('airwallex-api', airwallex, 'transfer_out').counterparty).toBe(
      'ACME Ltd'
    );
  });
});
