import { describe, expect, test } from 'bun:test';
import {
  AccountWithGroupsDto,
  AssignAccountGroupsDto,
  AssignHoldingGroupsDto,
  CreateGroupDto,
  GROUP_COLORS,
  GroupWithCountsDto,
  HoldingWithGroupsDto,
  UpdateGroupDto,
} from '../../src/dtos/group';

const VALID_UUID = '00000000-0000-4000-8000-000000000000';

describe('GROUP_COLORS', () => {
  test('exposes 18 distinct hex colors', () => {
    expect(GROUP_COLORS).toHaveLength(18);
    expect(new Set(GROUP_COLORS).size).toBe(18);
  });

  test('every entry is a 6-digit hex code', () => {
    for (const color of GROUP_COLORS) {
      expect(color).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe('CreateGroupDto', () => {
  test('accepts a well-formed payload', () => {
    expect(CreateGroupDto.safeParse({ name: 'Crypto', color: '#3b82f6' }).success).toBe(true);
  });

  test('accepts uppercase hex color', () => {
    expect(CreateGroupDto.safeParse({ name: 'x', color: '#ABCDEF' }).success).toBe(true);
  });

  test('accepts optional description and displayOrder', () => {
    expect(
      CreateGroupDto.safeParse({
        name: 'x',
        color: '#000000',
        description: 'a note',
        displayOrder: 3,
      }).success
    ).toBe(true);
  });

  test('description allows null (explicit clear)', () => {
    expect(
      CreateGroupDto.safeParse({ name: 'x', color: '#000000', description: null }).success
    ).toBe(true);
  });

  test('rejects empty name', () => {
    expect(CreateGroupDto.safeParse({ name: '', color: '#000000' }).success).toBe(false);
  });

  test('rejects name over 50 chars', () => {
    expect(CreateGroupDto.safeParse({ name: 'a'.repeat(51), color: '#000000' }).success).toBe(
      false
    );
  });

  test('rejects 3-digit hex (only 6-digit allowed)', () => {
    expect(CreateGroupDto.safeParse({ name: 'x', color: '#abc' }).success).toBe(false);
  });

  test('rejects bare color without hash', () => {
    expect(CreateGroupDto.safeParse({ name: 'x', color: '3b82f6' }).success).toBe(false);
  });

  test('rejects description over 200 chars', () => {
    expect(
      CreateGroupDto.safeParse({
        name: 'x',
        color: '#000000',
        description: 'a'.repeat(201),
      }).success
    ).toBe(false);
  });
});

describe('UpdateGroupDto', () => {
  test('accepts an empty patch (all optional)', () => {
    expect(UpdateGroupDto.safeParse({}).success).toBe(true);
  });

  test('accepts isActive toggle', () => {
    expect(UpdateGroupDto.safeParse({ isActive: false }).success).toBe(true);
  });

  test('rejects bad color when present', () => {
    expect(UpdateGroupDto.safeParse({ color: 'not-hex' }).success).toBe(false);
  });
});

describe('AssignHoldingGroupsDto / AssignAccountGroupsDto', () => {
  test('AssignHoldingGroupsDto accepts a valid payload', () => {
    expect(
      AssignHoldingGroupsDto.safeParse({ holdingId: VALID_UUID, groupIds: [VALID_UUID] }).success
    ).toBe(true);
  });

  test('AssignHoldingGroupsDto accepts an empty group list (clear-all)', () => {
    expect(AssignHoldingGroupsDto.safeParse({ holdingId: VALID_UUID, groupIds: [] }).success).toBe(
      true
    );
  });

  test('AssignHoldingGroupsDto rejects non-uuid groupIds', () => {
    expect(
      AssignHoldingGroupsDto.safeParse({ holdingId: VALID_UUID, groupIds: ['not-uuid'] }).success
    ).toBe(false);
  });

  test('AssignAccountGroupsDto accepts a valid payload', () => {
    expect(
      AssignAccountGroupsDto.safeParse({ accountId: VALID_UUID, groupIds: [VALID_UUID] }).success
    ).toBe(true);
  });
});

describe('HoldingWithGroupsDto / AccountWithGroupsDto', () => {
  test('HoldingWithGroupsDto accepts well-formed wire payload', () => {
    expect(
      HoldingWithGroupsDto.safeParse({
        id: 'h-1',
        groups: [{ id: 'g-1', name: 'Crypto', color: '#3b82f6' }],
      }).success
    ).toBe(true);
  });

  test('AccountWithGroupsDto accepts well-formed wire payload', () => {
    expect(
      AccountWithGroupsDto.safeParse({
        id: 'a-1',
        groups: [{ id: 'g-1', name: 'Bank', color: '#ef4444' }],
      }).success
    ).toBe(true);
  });

  test('HoldingWithGroupsDto requires groups array (even if empty)', () => {
    expect(HoldingWithGroupsDto.safeParse({ id: 'h-1' }).success).toBe(false);
  });
});

describe('GroupWithCountsDto', () => {
  test('accepts a complete group-with-counts row', () => {
    expect(
      GroupWithCountsDto.safeParse({
        id: 'g-1',
        userId: 'u-1',
        name: 'Crypto',
        color: '#3b82f6',
        description: null,
        displayOrder: 0,
        isActive: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        counts: { holdings: 12, accounts: 3 },
      }).success
    ).toBe(true);
  });

  test('rejects missing counts', () => {
    expect(
      GroupWithCountsDto.safeParse({
        id: 'g-1',
        userId: 'u-1',
        name: 'Crypto',
        color: '#3b82f6',
        description: null,
        displayOrder: 0,
        isActive: true,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }).success
    ).toBe(false);
  });
});
