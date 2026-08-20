import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import {
  candidatesFor,
  compareMembers,
  countOfKind,
  inactiveMemberCount,
  type MemberEntry,
  memberCountLine,
  memberMatches,
} from '../../../src/v3/lib/membership';

const t = i18n.t.bind(i18n);

function holding(id: string, label: string, sublabel = 'Bitcoin · Kraken'): MemberEntry {
  return { id, kind: 'holding', label, sublabel };
}

function account(id: string, label: string, sublabel = '3 holdings'): MemberEntry {
  return { id, kind: 'account', label, sublabel };
}

describe('compareMembers', () => {
  test('puts every holding before every account', () => {
    const sorted = [account('a1', 'AAA'), holding('h1', 'ZZZ')].sort(compareMembers);
    expect(sorted.map((entry) => entry.kind)).toEqual(['holding', 'account']);
  });

  test('sorts alphabetically inside a kind', () => {
    const sorted = [holding('h2', 'SOL'), holding('h1', 'BTC')].sort(compareMembers);
    expect(sorted.map((entry) => entry.label)).toEqual(['BTC', 'SOL']);
  });
});

describe('memberMatches', () => {
  test('an empty query matches everything, so an unfiltered list is not empty', () => {
    expect(memberMatches(holding('h1', 'BTC'), '   ')).toBe(true);
  });

  test('matches the sublabel too — a reader searches by institution', () => {
    expect(memberMatches(holding('h1', 'BTC', 'Bitcoin · Kraken'), 'kraken')).toBe(true);
  });

  test('does not match an unrelated query', () => {
    expect(memberMatches(holding('h1', 'BTC', 'Bitcoin · Kraken'), 'revolut')).toBe(false);
  });
});

describe('memberCountLine', () => {
  test('reads the singular as a singular — "1 holdings" is the defect it fixes', () => {
    expect(memberCountLine([holding('h1', 'BTC'), account('a1', 'Main')], t)).toBe(
      '1 holding · 1 account'
    );
  });

  test('says zero of both rather than going blank', () => {
    expect(memberCountLine([], t)).toBe('0 holdings · 0 accounts');
  });

  test('counts each kind independently', () => {
    const members = [holding('h1', 'BTC'), holding('h2', 'ETH'), account('a1', 'Main')];
    expect(memberCountLine(members, t)).toBe('2 holdings · 1 account');
  });
});

describe('countOfKind', () => {
  /**
   * SC-388: the group page titled its member list with `members.length` — 46
   * over a group of 36 holdings and 10 accounts, printed directly above 36
   * rows. Counting is per kind now and there is no helper that adds them.
   */
  test('counts one kind at a time', () => {
    const members = [holding('h1', 'BTC'), holding('h2', 'ETH'), account('a1', 'Main')];
    expect(countOfKind(members, 'holding')).toBe(2);
    expect(countOfKind(members, 'account')).toBe(1);
  });
});

describe('inactiveMemberCount', () => {
  test('an ordinary group has none', () => {
    expect(inactiveMemberCount([holding('h1', 'BTC'), account('a1', 'Main')])).toBe(0);
  });

  test('counts the listed holdings the group total leaves out', () => {
    const members = [
      holding('h1', 'BTC'),
      { ...holding('h2', 'ETH'), inactive: true },
      { ...holding('h3', 'SOL'), inactive: true },
      account('a1', 'Main'),
    ];
    expect(inactiveMemberCount(members)).toBe(2);
  });
});

describe('candidatesFor', () => {
  const all = [holding('h1', 'BTC'), holding('h2', 'ETH'), account('a1', 'Main')];

  test('excludes everything already a member', () => {
    const candidates = candidatesFor(all, [holding('h1', 'BTC')]);
    expect(candidates.map((entry) => entry.id)).toEqual(['h2', 'a1']);
  });

  test('keys on kind as well as id, so a holding and an account may share one', () => {
    const collide = [holding('same', 'BTC'), account('same', 'Main')];
    const candidates = candidatesFor(collide, [holding('same', 'BTC')]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.kind).toBe('account');
  });

  test('returns nothing when every entry is already in', () => {
    expect(candidatesFor(all, all)).toEqual([]);
  });

  test('comes back in the member list order, not the source order', () => {
    const candidates = candidatesFor([account('a1', 'Main'), holding('h1', 'BTC')], []);
    expect(candidates.map((entry) => entry.kind)).toEqual(['holding', 'account']);
  });
});
