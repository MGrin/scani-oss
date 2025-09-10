/**
 * Type-safe utilities for converting tRPC API responses to typed objects
 *
 * The issue: tRPC returns data from the database with string dates and string enum values,
 * but our TypeScript types expect proper Date objects and typed enums.
 *
 * This file provides utilities to safely convert API responses to the expected types.
 */

import type { Account, Holding, Institution, Token, Transaction } from '@scani/shared';

// API response types (what we actually get from tRPC)
export type ApiInstitution = Omit<
  Institution,
  'createdAt' | 'updatedAt' | 'type' | 'description' | 'website' | 'logoUrl'
> & {
  createdAt: string;
  updatedAt: string;
  type: string;
  description: string | null;
  website: string | null;
  logoUrl: string | null;
};

export type ApiAccount = Omit<
  Account,
  'createdAt' | 'updatedAt' | 'type' | 'description' | 'accountNumber'
> & {
  createdAt: string;
  updatedAt: string;
  type: string;
  description: string | null;
  accountNumber: string | null;
};

export type ApiToken = Omit<Token, 'createdAt' | 'updatedAt' | 'type' | 'iconUrl'> & {
  createdAt: string;
  updatedAt: string;
  type: string;
  iconUrl: string | undefined;
};

export type ApiHolding = Omit<Holding, 'createdAt' | 'lastUpdated' | 'averageCostBasis'> & {
  createdAt: string;
  lastUpdated: string;
  averageCostBasis: number | null;
};

export type ApiTransaction = Omit<
  Transaction,
  'createdAt' | 'updatedAt' | 'timestamp' | 'type' | 'description' | 'reference'
> & {
  createdAt: string;
  updatedAt: string;
  timestamp: string;
  type: string;
  description: string | undefined;
  reference: string | undefined;
};

// Conversion functions
export const convertApiInstitution = (api: ApiInstitution): Institution =>
  ({
    ...api,
    createdAt: new Date(api.createdAt),
    updatedAt: new Date(api.updatedAt),
    description: api.description || undefined,
    website: api.website || undefined,
    logoUrl: api.logoUrl || undefined,
  }) as Institution;

export const convertApiAccount = (api: ApiAccount): Account =>
  ({
    ...api,
    createdAt: new Date(api.createdAt),
    updatedAt: new Date(api.updatedAt),
    description: api.description || undefined,
    accountNumber: api.accountNumber || undefined,
  }) as Account;

export const convertApiToken = (api: ApiToken): Token =>
  ({
    ...api,
    createdAt: new Date(api.createdAt),
    updatedAt: new Date(api.updatedAt),
  }) as Token;

export const convertApiHolding = (api: ApiHolding): Holding =>
  ({
    ...api,
    createdAt: new Date(api.createdAt),
    lastUpdated: new Date(api.lastUpdated),
    averageCostBasis: api.averageCostBasis || undefined,
  }) as Holding;

export const convertApiTransaction = (api: ApiTransaction): Transaction =>
  ({
    ...api,
    createdAt: new Date(api.createdAt),
    updatedAt: new Date(api.updatedAt),
    timestamp: new Date(api.timestamp),
    description: api.description || undefined,
    reference: api.reference || undefined,
  }) as Transaction;

// Type guards for runtime checking
export const isApiInstitution = (obj: unknown): obj is ApiInstitution => {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    'createdAt' in obj &&
    'updatedAt' in obj &&
    typeof (obj as Record<string, unknown>).createdAt === 'string' &&
    typeof (obj as Record<string, unknown>).updatedAt === 'string'
  );
};

export const isApiAccount = (obj: unknown): obj is ApiAccount => {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    'createdAt' in obj &&
    'updatedAt' in obj &&
    typeof (obj as Record<string, unknown>).createdAt === 'string' &&
    typeof (obj as Record<string, unknown>).updatedAt === 'string'
  );
};

export const isApiToken = (obj: unknown): obj is ApiToken => {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    'createdAt' in obj &&
    'updatedAt' in obj &&
    typeof (obj as Record<string, unknown>).createdAt === 'string' &&
    typeof (obj as Record<string, unknown>).updatedAt === 'string'
  );
};

export const isApiHolding = (obj: unknown): obj is ApiHolding => {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    'createdAt' in obj &&
    'lastUpdated' in obj &&
    typeof (obj as Record<string, unknown>).createdAt === 'string' &&
    typeof (obj as Record<string, unknown>).lastUpdated === 'string'
  );
};

export const isApiTransaction = (obj: unknown): obj is ApiTransaction => {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    'createdAt' in obj &&
    'updatedAt' in obj &&
    'timestamp' in obj &&
    typeof (obj as Record<string, unknown>).createdAt === 'string' &&
    typeof (obj as Record<string, unknown>).updatedAt === 'string' &&
    typeof (obj as Record<string, unknown>).timestamp === 'string'
  );
};
