/**
 * tRPC inferred types for API responses
 *
 * This file extracts the actual types returned by tRPC procedures,
 * eliminating the need for manual type definitions.
 */

import type { AppRouter } from '@scani/backend/router';
import type { inferRouterOutputs } from '@trpc/server';

// Infer all router outputs
type RouterOutputs = inferRouterOutputs<AppRouter>;

// Extract specific route outputs
export type TRPCInstitution = RouterOutputs['institutions']['getAll'][number];
export type TRPCAccount = RouterOutputs['accounts']['getAll'][number];
export type TRPCToken = RouterOutputs['tokens']['getAll'][number];
export type TRPCHolding = RouterOutputs['holdings']['getAll'][number];
export type TRPCTransaction = RouterOutputs['transactions']['getAll'][number];

// Create aliases for easier migration
export type ApiInstitution = TRPCInstitution;
export type ApiAccount = TRPCAccount;
export type ApiToken = TRPCToken;
export type ApiHolding = TRPCHolding;
export type ApiTransaction = TRPCTransaction;

// Export the router outputs type for advanced usage
export type { RouterOutputs };
