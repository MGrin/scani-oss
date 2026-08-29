import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import { describeBalanceRefresh } from '../../../src/v3/lib/balance-refresh-outcome';

const t = i18n.t.bind(i18n);

/**
 * SC-852. A symbol the venue did not return meant one thing to this hook —
 * "wasn't returned by the provider — try again in a minute" — and two things
 * in the world. Etherscan's balance discovery drops every zero, so a token
 * that LEFT the wallet is absent for good, and the advice to retry can never
 * work: whoever follows it follows it forever, while the dashboard keeps
 * counting a position the chain reports as `0x0`.
 *
 * EVERY ASSERTION HERE IS A PAIR. A test that only checked the error was gone
 * would pass for a hook that calls every absence an exit, which is the same
 * collapse pointing the other way — and that one puts a zero on screen over a
 * position somebody still holds.
 */

const EXITED = { syncedSymbols: ['ETH'], missingSymbols: [], exitedSymbols: ['USDC'] };
const UNRESOLVED = { syncedSymbols: ['ETH'], missingSymbols: ['USDC'], exitedSymbols: [] };

describe('describeBalanceRefresh — the two causes of an absence (SC-852)', () => {
  /**
   * THE CONTROL. Same pressed symbol, same absence from `syncedSymbols`, and
   * the outcomes have to differ in kind AND in wording — the kind is what
   * decides `showError` against `showSuccess`, and the words are what the
   * person actually acts on.
   */
  test('a departed position and an unresolved one do not read alike', () => {
    const exited = describeBalanceRefresh(t, EXITED, 'USDC');
    const unresolved = describeBalanceRefresh(t, UNRESOLVED, 'USDC');

    expect(exited.kind).toBe('exited');
    expect(unresolved.kind).toBe('unresolved');
    expect(exited.message).not.toBe(unresolved.message);
  });

  // The sentence itself, because the kind alone does not reach the reader.
  // "Try again in a minute" is the impossible half, and it must not survive
  // into the branch where the position is gone.
  test('an exit does not tell anyone to try again', () => {
    const { message } = describeBalanceRefresh(t, EXITED, 'USDC');
    expect(message).toInclude('USDC');
    expect(message).not.toInclude('Try again');
    expect(message).not.toInclude('{{');
  });

  // …and it must survive in the branch where it is true. Without this the
  // assertion above is satisfied by deleting the advice everywhere.
  test('an unresolved absence still says to try again, and still titles itself', () => {
    const outcome = describeBalanceRefresh(t, UNRESOLVED, 'USDC');
    expect(outcome.message).toInclude('Try again in a minute');
    expect(outcome.title).toBe('Balance refresh — partial');
  });

  /**
   * Order, which is the behaviour rather than a detail. An exited symbol is by
   * construction absent from `syncedSymbols`; a backend that also listed it as
   * missing — or a hook that tested `missing` first — drops it straight back
   * into the retry-forever branch and nothing else in this file would notice.
   */
  test('an exit wins over a stale "missing" entry for the same symbol', () => {
    const outcome = describeBalanceRefresh(
      t,
      { syncedSymbols: ['ETH'], missingSymbols: ['USDC'], exitedSymbols: ['USDC'] },
      'USDC'
    );
    expect(outcome.kind).toBe('exited');
  });

  test('an exit for a different symbol does not silence the pressed one', () => {
    const outcome = describeBalanceRefresh(
      t,
      { syncedSymbols: ['ETH'], missingSymbols: ['USDC'], exitedSymbols: ['GALA'] },
      'USDC'
    );
    expect(outcome.kind).toBe('unresolved');
  });
});

describe('describeBalanceRefresh — the outcomes that did not change (SC-852)', () => {
  test('a symbol the provider returned reads as refreshed', () => {
    const outcome = describeBalanceRefresh(t, { syncedSymbols: ['USDC', 'ETH'] }, 'USDC');
    expect(outcome.kind).toBe('one');
    expect(outcome.message).toBe('USDC balance refreshed');
  });

  /**
   * A job row from before `exitedSymbols` existed carries neither list. It
   * must not become an error: the safe default is the count, which claims
   * nothing about any particular symbol.
   */
  test('a report from an older job falls back to the count, not to an error', () => {
    const outcome = describeBalanceRefresh(t, null, 'USDC');
    expect(outcome.kind).toBe('many');
    expect(outcome.message).toBe('Refreshed 0 balances on this account');
  });

  test('comparison is case-insensitive on both sides', () => {
    const outcome = describeBalanceRefresh(t, { exitedSymbols: ['usdc'] }, 'USDC');
    expect(outcome.kind).toBe('exited');
  });
});
