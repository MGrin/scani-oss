import { z } from 'zod';
import { Decimal, isValidDecimalString } from '../decimal';

// Reuse the same color palette as groups
export { GROUP_COLORS } from './group';

export const CreateVaultDto = z.object({
  name: z.string().min(1).max(100),
  targetAmount: z.string().refine(
    (val) => {
      if (!isValidDecimalString(val)) return false;
      return new Decimal(val).greaterThan(0);
    },
    {
      message: 'Target amount must be a valid positive decimal number string',
    }
  ),
  currencyId: z.string().uuid(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
  iconName: z.string().max(50).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
});

export type CreateVaultInput = z.infer<typeof CreateVaultDto>;

export const UpdateVaultDto = z.object({
  name: z.string().min(1).max(100).optional(),
  targetAmount: z
    .string()
    .refine(
      (val) => {
        if (!isValidDecimalString(val)) return false;
        return new Decimal(val).greaterThan(0);
      },
      {
        message: 'Target amount must be a valid positive decimal number string',
      }
    )
    .optional(),
  currencyId: z.string().uuid().optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  iconName: z.string().max(50).optional().nullable(),
  description: z.string().max(500).optional().nullable(),
  isActive: z.boolean().optional(),
});

export type UpdateVaultInput = z.infer<typeof UpdateVaultDto>;

export const AttachHoldingToVaultDto = z.object({
  vaultId: z.string().uuid(),
  holdingId: z.string().uuid(),
  percentage: z
    .number()
    .min(0.01, 'Percentage must be greater than 0')
    .max(100, 'Percentage cannot exceed 100'),
});

export type AttachHoldingToVaultInput = z.infer<typeof AttachHoldingToVaultDto>;

export const UpdateVaultHoldingDto = z.object({
  vaultId: z.string().uuid(),
  holdingId: z.string().uuid(),
  percentage: z
    .number()
    .min(0.01, 'Percentage must be greater than 0')
    .max(100, 'Percentage cannot exceed 100'),
});

export type UpdateVaultHoldingInput = z.infer<typeof UpdateVaultHoldingDto>;

export const DetachHoldingFromVaultDto = z.object({
  vaultId: z.string().uuid(),
  holdingId: z.string().uuid(),
});

export type DetachHoldingFromVaultInput = z.infer<typeof DetachHoldingFromVaultDto>;

// Types for vault display with progress

export type VaultHoldingDetail = {
  holdingId: string;
  percentage: number;
  tokenSymbol: string;
  tokenName: string;
  tokenIconUrl: string | null;
  accountName: string;
  institutionName: string;
  holdingBalance: string;
  // `null` when the holding's token can't be priced in the vault's
  // currency (no live price, no stale fallback, no fiat-pair rate).
  // UI renders "—" so the missing value is visible — never $0.
  holdingValue: string | null;
  attributedValue: string | null;
};

export type VaultWithProgress = {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  targetAmount: string;
  currencyId: string;
  currencySymbol: string;
  currencyName: string;
  currentAmount: string;
  progress: number; // 0-100+ percentage of target reached
  color: string;
  iconName: string | null;
  isActive: boolean;
  holdingsCount: number;
  holdings: VaultHoldingDetail[];
  createdAt: string;
  updatedAt: string;
};
