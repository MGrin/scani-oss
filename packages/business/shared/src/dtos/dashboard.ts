import z from 'zod';

export const AssetAllocationDimensionDto = z.enum([
  'token',
  'token_type',
  'account',
  'account_type',
  'institution',
  'institution_type',
  'group',
]);

export type AssetAllocationDimension = z.infer<typeof AssetAllocationDimensionDto>;

export const GetAssetAllocationInputDto = z.object({
  dimension: AssetAllocationDimensionDto,
});

export const AssetAllocationItemDto = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  value: z.string(),
  percentage: z.string(),
});

export type AssetAllocationItem = z.infer<typeof AssetAllocationItemDto>;

export const GetAssetAllocationOutputDto = z.object({
  dimension: AssetAllocationDimensionDto,
  items: z.array(AssetAllocationItemDto),
  /** Signed: `"0"`, or the negative sum of the holdings kept out of `items` (SC-1463). */
  marginDebt: z.string(),
  totalValue: z.string(),
  baseCurrency: z.string(),
});
