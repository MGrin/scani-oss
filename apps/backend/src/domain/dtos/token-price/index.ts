import { z } from 'zod';

export const CreateTokenPriceDto = z.object({
  tokenId: z.string().uuid(),
  baseTokenId: z.string().uuid(),
  price: z.string().refine((val) => !Number.isNaN(parseFloat(val)) && parseFloat(val) >= 0, {
    message: 'Price must be a valid non-negative number string',
  }),
  timestamp: z.date(),
  source: z.string().max(200).optional(),
});

export const UpdateTokenPriceDto = z.object({
  price: z
    .string()
    .refine((val) => !Number.isNaN(parseFloat(val)) && parseFloat(val) >= 0, {
      message: 'Price must be a valid non-negative number string',
    })
    .optional(),
  source: z.string().max(200).optional(),
});

export const BulkUpsertTokenPricesDto = z.object({
  prices: z.array(
    z.object({
      tokenId: z.string().uuid(),
      baseTokenId: z.string().uuid(),
      price: z.string(),
      timestamp: z.date(),
      source: z.string().optional(),
    })
  ),
});

export interface TokenPriceResponseDto {
  id: string;
  tokenId: string;
  baseTokenId: string;
  price: string;
  timestamp: Date;
  source: string | null;
  createdAt: Date;
}

export interface TokenPriceHistoryDto {
  tokenId: string;
  tokenSymbol: string;
  baseTokenId: string;
  baseTokenSymbol: string;
  prices: Array<{
    price: string;
    timestamp: Date;
    source: string | null;
  }>;
}

export type CreateTokenPriceInput = z.infer<typeof CreateTokenPriceDto>;
export type UpdateTokenPriceInput = z.infer<typeof UpdateTokenPriceDto>;
export type BulkUpsertTokenPricesInput = z.infer<typeof BulkUpsertTokenPricesDto>;
