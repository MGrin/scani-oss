import z from 'zod';
import { CreateAccountDto } from './account';
import type { Holding } from './holding';
import { CreateInstitutionDto } from './institution';

export const CreateHoldingsWithDependenciesDto = z.object({
  institution: CreateInstitutionDto.optional(),

  accountId: z.string().uuid().optional(),
  account: CreateAccountDto.optional(),

  holdings: z
    .array(
      z.object({
        tokenId: z.string().uuid(),
        balance: z.string().regex(/^-?\d+\.?\d*$/, 'Balance must be a valid decimal string'),
      })
    )
    .min(1, 'At least one holding is required'),
});

export type CreateHoldingsWithDependenciesInput = z.infer<typeof CreateHoldingsWithDependenciesDto>;

export type CreateHoldingsWithDependenciesResponseDto = {
  institutionId: string;
  accountId: string;
  holdings: Holding[];
  createdInstitution: boolean;
  createdAccount: boolean;
};
