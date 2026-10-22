import '../../i18n-preload';
import { describe, expect, test } from 'bun:test';
import { type HouseholdAccount, memberShares } from '../../../src/v3/lib/household-view';

const account = (ownerId: string, value: string): HouseholdAccount => ({
  accountId: `${ownerId}-${value}`,
  name: 'Account',
  institutionId: 'inst',
  institutionName: 'Bank',
  institutionWebsite: null,
  ownerId,
  ownerName: ownerId,
  ownedByViewer: false,
  value,
});

describe('what each member shares (SC-1712)', () => {
  const members = [
    { userId: 'theo', name: 'Theo', role: 'member' as const, joinedAt: '2026-10-02' },
    { userId: 'ivy', name: 'Ivy', role: 'admin' as const, joinedAt: '2026-10-01' },
    { userId: 'sam', name: 'Sam', role: 'member' as const, joinedAt: '2026-10-03' },
  ];
  const accounts = [account('ivy', '100.5'), account('ivy', '50'), account('theo', '30')];

  test('counts and sums each member’s shared accounts', () => {
    const byId = new Map(memberShares(members, accounts).map((m) => [m.userId, m]));
    expect(byId.get('ivy')).toMatchObject({ count: 2, value: 150.5 });
    expect(byId.get('theo')).toMatchObject({ count: 1, value: 30 });
  });

  test('a member who shares nothing is still listed, at zero', () => {
    const sam = memberShares(members, accounts).find((m) => m.userId === 'sam');
    expect(sam).toMatchObject({ count: 0, value: 0 });
  });

  test('the admin comes first, then the rest by what they share', () => {
    expect(memberShares(members, accounts).map((m) => m.userId)).toEqual(['ivy', 'theo', 'sam']);
  });
});
