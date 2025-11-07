import z from 'zod';

export const AssetAllocationDimensionDto = z.enum([
  'token',
  'token_type',
  'account',
  'account_type',
  'institution',
  'institution_type',
]);

export type AssetAllocationDimension = z.infer<typeof AssetAllocationDimensionDto>;

export const GetAssetAllocationInputDto = z.object({
  dimension: AssetAllocationDimensionDto,
});

export type GetAssetAllocationInput = z.infer<typeof GetAssetAllocationInputDto>;

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
  totalValue: z.string(),
  baseCurrency: z.string(),
});

export type GetAssetAllocationOutput = z.infer<typeof GetAssetAllocationOutputDto>;
