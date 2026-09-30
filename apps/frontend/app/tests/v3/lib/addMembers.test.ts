import '../../i18n-preload';
import { describe, expect, test } from 'bun:test';
import {
  allocatedElsewhere,
  coveringParentId,
  entriesToAdd,
  shareIssue,
  shareValue,
} from '../../../src/v3/lib/addMembers';
import type { MemberEntry } from '../../../src/v3/lib/membership';

const account = (id: string): MemberEntry => ({
  id,
  kind: 'account',
  label: `Account ${id}`,
  sublabel: '',
});
const holding = (id: string, accountId: string): MemberEntry => ({
  id,
  kind: 'holding',
  label: `Holding ${id}`,
  sublabel: '',
  accountId,
});

describe('group add: an account brings its holdings (SC-1411)', () => {
  test('a holding whose account is ticked names that account', () => {
    expect(coveringParentId(holding('h1', 'a1'), new Set(['a1']))).toBe('a1');
  });

  test('a holding in an unticked account, and an account itself, are not covered', () => {
    expect(coveringParentId(holding('h1', 'a2'), new Set(['a1']))).toBeUndefined();
    expect(coveringParentId(account('a1'), new Set(['a1']))).toBeUndefined();
  });

  test('saving drops the holdings a ticked account already brings', () => {
    const chosen = [account('a1'), holding('h1', 'a1'), holding('h2', 'a2')];
    expect(entriesToAdd(chosen).map((e) => `${e.kind}:${e.id}`)).toEqual([
      'account:a1',
      'holding:h2',
    ]);
  });
});

const payee = (id: string): MemberEntry => ({
  id,
  kind: 'payee',
  label: `Payee ${id}`,
  sublabel: '',
});
const bill = (id: string, payeeId: string): MemberEntry => ({
  id,
  kind: 'bill',
  label: `Bill ${id}`,
  sublabel: '',
  payeeId,
});

// SC-1408: a payee's rule brings its bills the way an account brings its
// holdings, so the add sheet treats the pair the same way.
describe('group add: a payee brings its bills (SC-1408)', () => {
  test('a bill whose payee is ticked names that payee', () => {
    expect(coveringParentId(bill('b1', 'p1'), new Set(['p1']))).toBe('p1');
  });

  test('a bill of an unticked payee, and a payee itself, are not covered', () => {
    expect(coveringParentId(bill('b1', 'p2'), new Set(['p1']))).toBeUndefined();
    expect(coveringParentId(payee('p1'), new Set(['p1']))).toBeUndefined();
  });

  test('saving drops the bills a ticked payee already brings, and keeps the rest', () => {
    const chosen = [
      payee('p1'),
      bill('b1', 'p1'),
      bill('b2', 'p2'),
      account('a1'),
      holding('h1', 'a1'),
    ];
    expect(entriesToAdd(chosen).map((e) => `${e.kind}:${e.id}`)).toEqual([
      'payee:p1',
      'bill:b2',
      'account:a1',
    ]);
  });
});

describe('vault attach: the share each holding contributes (SC-1411)', () => {
  test('a share is required, positive, at most two decimals, and within what is free', () => {
    expect(shareIssue(undefined, 60)).toBe('missing');
    expect(shareIssue(0, 60)).toBe('missing');
    expect(shareIssue(33.334, 60)).toBe('tooPrecise');
    expect(shareIssue(61, 60)).toBe('overAvailable');
  });

  test('the control: a share within bounds has no issue, including all that is free', () => {
    expect(shareIssue(25.1, 60)).toBeNull();
    expect(shareIssue(60, 60)).toBeNull();
    expect(shareIssue(100, 100)).toBeNull();
  });

  test('names the other vaults a holding already counts toward, largest first', () => {
    const allocations = [
      { holdingId: 'h1', vaultId: 'v2', percentage: 15 },
      { holdingId: 'h1', vaultId: 'v3', percentage: 25 },
      { holdingId: 'h1', vaultId: 'v1', percentage: 10 },
      { holdingId: 'h2', vaultId: 'v2', percentage: 50 },
    ];
    const names = new Map([
      ['v2', 'Emergency'],
      ['v3', 'House'],
    ]);
    expect(allocatedElsewhere('h1', 'v1', allocations, names)).toEqual([
      { name: 'House', percentage: 25 },
      { name: 'Emergency', percentage: 15 },
    ]);
  });

  test('what the vault gains is the share of the holding, and unknown stays unknown', () => {
    expect(shareValue('200', 25)).toBe(50);
    expect(shareValue(null, 25)).toBeNull();
    expect(shareValue('200', undefined)).toBeNull();
  });
});
