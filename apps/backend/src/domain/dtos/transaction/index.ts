import { z } from 'zod';

export const CreateTransactionDto = z.object({
  holdingId: z.string().uuid(),
  typeCode: z.string().min(1),
  amount: z.string().refine((val) => !Number.isNaN(parseFloat(val)), {
    message: 'Amount must be a valid number string',
  }),
  fee: z
    .string()
    .refine((val) => !Number.isNaN(parseFloat(val)) && parseFloat(val) >= 0, {
      message: 'Fee must be a valid non-negative number string',
    })
    .default('0'),
  feeTokenId: z.string().uuid().optional(),
  description: z.string().max(500).optional(),
  reference: z.string().max(200).optional(),
  timestamp: z.date(),
});

export const UpdateTransactionDto = z.object({
  typeCode: z.string().min(1).optional(),
  amount: z
    .string()
    .refine((val) => !Number.isNaN(parseFloat(val)), {
      message: 'Amount must be a valid number string',
    })
    .optional(),
  fee: z
    .string()
    .refine((val) => !Number.isNaN(parseFloat(val)) && parseFloat(val) >= 0, {
      message: 'Fee must be a valid non-negative number string',
    })
    .optional(),
  feeTokenId: z.string().uuid().nullable().optional(),
  description: z.string().max(500).optional(),
  reference: z.string().max(200).optional(),
  timestamp: z.date().optional(),
});

export interface TransactionResponseDto {
  id: string;
  userId: string;
  holdingId: string;
  typeId: string;
  type: string | null;
  typeName: string | null;
  amount: string;
  fee: string;
  feeTokenId: string | null;
  description: string | null;
  reference: string | null;
  timestamp: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface TransactionWithDetailsDto extends TransactionResponseDto {
  tokenSymbol: string;
  tokenName: string;
  baseCurrencyAmount?: string;
  baseCurrencyFee?: string;
  baseCurrencySymbol?: string;
}

export type CreateTransactionInput = z.infer<typeof CreateTransactionDto>;
export type UpdateTransactionInput = z.infer<typeof UpdateTransactionDto>;
