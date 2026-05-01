import { describe, expect, test } from 'bun:test';
import {
  AttachHoldingToVaultDto,
  CreateVaultDto,
  DetachHoldingFromVaultDto,
  GROUP_COLORS,
  UpdateVaultDto,
  UpdateVaultHoldingDto,
} from '../../src/dtos/vault';

const VALID_UUID = '00000000-0000-4000-8000-000000000000';
const OTHER_UUID = '11111111-1111-4111-8111-111111111111';

describe('GROUP_COLORS re-export', () => {
  test('vault re-exports the group color palette unchanged', () => {
    expect(GROUP_COLORS).toHaveLength(18);
  });
});

describe('CreateVaultDto', () => {
  const base = {
    name: 'Emergency Fund',
    targetAmount: '10000',
    currencyId: VALID_UUID,
    color: '#3b82f6',
  };

  test('accepts a minimal valid payload', () => {
    expect(CreateVaultDto.safeParse(base).success).toBe(true);
  });

  test('accepts a positive decimal target amount', () => {
    expect(CreateVaultDto.safeParse({ ...base, targetAmount: '12345.6789' }).success).toBe(true);
  });

  test('accepts iconName and description', () => {
    expect(
      CreateVaultDto.safeParse({
        ...base,
        iconName: 'piggy-bank',
        description: 'For unexpected expenses',
      }).success
    ).toBe(true);
  });

  test('iconName and description accept null (explicit clear)', () => {
    expect(CreateVaultDto.safeParse({ ...base, iconName: null, description: null }).success).toBe(
      true
    );
  });

  test('rejects 0 target amount', () => {
    expect(CreateVaultDto.safeParse({ ...base, targetAmount: '0' }).success).toBe(false);
  });

  test('rejects negative target amount', () => {
    expect(CreateVaultDto.safeParse({ ...base, targetAmount: '-100' }).success).toBe(false);
  });

  test('rejects non-decimal target amount string', () => {
    expect(CreateVaultDto.safeParse({ ...base, targetAmount: 'a-lot' }).success).toBe(false);
    expect(CreateVaultDto.safeParse({ ...base, targetAmount: 'NaN' }).success).toBe(false);
  });

  test('rejects empty name', () => {
    expect(CreateVaultDto.safeParse({ ...base, name: '' }).success).toBe(false);
  });

  test('rejects name over 100 chars', () => {
    expect(CreateVaultDto.safeParse({ ...base, name: 'a'.repeat(101) }).success).toBe(false);
  });

  test('rejects non-uuid currencyId', () => {
    expect(CreateVaultDto.safeParse({ ...base, currencyId: 'not-a-uuid' }).success).toBe(false);
  });

  test('rejects bad color hex', () => {
    expect(CreateVaultDto.safeParse({ ...base, color: 'not-hex' }).success).toBe(false);
    expect(CreateVaultDto.safeParse({ ...base, color: '#abc' }).success).toBe(false);
  });

  test('rejects iconName over 50 chars', () => {
    expect(CreateVaultDto.safeParse({ ...base, iconName: 'a'.repeat(51) }).success).toBe(false);
  });

  test('rejects description over 500 chars', () => {
    expect(CreateVaultDto.safeParse({ ...base, description: 'a'.repeat(501) }).success).toBe(false);
  });
});

describe('UpdateVaultDto', () => {
  test('accepts an empty patch (all fields optional)', () => {
    expect(UpdateVaultDto.safeParse({}).success).toBe(true);
  });

  test('accepts isActive toggle alone', () => {
    expect(UpdateVaultDto.safeParse({ isActive: false }).success).toBe(true);
  });

  test('rejects 0 target amount when present', () => {
    expect(UpdateVaultDto.safeParse({ targetAmount: '0' }).success).toBe(false);
  });

  test('accepts a valid positive target amount', () => {
    expect(UpdateVaultDto.safeParse({ targetAmount: '5000' }).success).toBe(true);
  });
});

describe('AttachHoldingToVaultDto / UpdateVaultHoldingDto', () => {
  const base = { vaultId: VALID_UUID, holdingId: OTHER_UUID, percentage: 25 };

  test('AttachHoldingToVaultDto accepts a valid payload', () => {
    expect(AttachHoldingToVaultDto.safeParse(base).success).toBe(true);
  });

  test('UpdateVaultHoldingDto accepts a valid payload', () => {
    expect(UpdateVaultHoldingDto.safeParse(base).success).toBe(true);
  });

  test('percentage boundary: 0.01 ok', () => {
    expect(AttachHoldingToVaultDto.safeParse({ ...base, percentage: 0.01 }).success).toBe(true);
  });

  test('percentage boundary: 100 ok', () => {
    expect(AttachHoldingToVaultDto.safeParse({ ...base, percentage: 100 }).success).toBe(true);
  });

  test('percentage rejects 0 (must be > 0)', () => {
    expect(AttachHoldingToVaultDto.safeParse({ ...base, percentage: 0 }).success).toBe(false);
  });

  test('percentage rejects > 100', () => {
    expect(AttachHoldingToVaultDto.safeParse({ ...base, percentage: 100.01 }).success).toBe(false);
  });

  test('rejects non-uuid ids', () => {
    expect(AttachHoldingToVaultDto.safeParse({ ...base, vaultId: 'not-a-uuid' }).success).toBe(
      false
    );
    expect(AttachHoldingToVaultDto.safeParse({ ...base, holdingId: 'not-a-uuid' }).success).toBe(
      false
    );
  });
});

describe('DetachHoldingFromVaultDto', () => {
  test('accepts a valid payload', () => {
    expect(
      DetachHoldingFromVaultDto.safeParse({ vaultId: VALID_UUID, holdingId: OTHER_UUID }).success
    ).toBe(true);
  });

  test('rejects missing fields', () => {
    expect(DetachHoldingFromVaultDto.safeParse({ vaultId: VALID_UUID }).success).toBe(false);
    expect(DetachHoldingFromVaultDto.safeParse({ holdingId: OTHER_UUID }).success).toBe(false);
  });
});
