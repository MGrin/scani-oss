import type { trpc } from '@/lib/trpc';

/**
 * Utility functions for consistent data invalidation patterns
 */

/**
 * Invalidate all financial data queries
 * Use this for complex operations that affect multiple data types
 */
export const invalidateAllFinancialData = (utils: ReturnType<typeof trpc.useUtils>) => {
  utils.accounts.getAll.invalidate();
  utils.accounts.getById.invalidate();
  utils.accounts.getByUserIdWithSummary.invalidate();
  utils.accounts.getHoldings.invalidate();
  utils.holdings.getAll.invalidate();
  utils.holdings.getWithDetails.invalidate();
  utils.institutions.getAll.invalidate();
  utils.institutions.getByUserId.invalidate();
  utils.institutions.getByUserIdWithSummary.invalidate();
  utils.dashboard.getOverview.invalidate();
};

/**
 * Invalidate account-related queries
 * Use this after account creation, updates, or deletions
 */
export const invalidateAccountData = (utils: ReturnType<typeof trpc.useUtils>) => {
  utils.accounts.getAll.invalidate();
  utils.accounts.getById.invalidate();
  utils.accounts.getByUserIdWithSummary.invalidate();
  utils.accounts.getHoldings.invalidate();
  utils.dashboard.getOverview.invalidate();
};

/**
 * Invalidate holding-related queries
 * Use this after holding creation, updates, or deletions
 */
export const invalidateHoldingData = (utils: ReturnType<typeof trpc.useUtils>) => {
  utils.holdings.getAll.invalidate();
  utils.holdings.getWithDetails.invalidate();
  utils.accounts.getHoldings.invalidate();
  utils.accounts.getByUserIdWithSummary.invalidate();
  utils.dashboard.getOverview.invalidate();
};

/**
 * Invalidate institution-related queries
 * Use this after institution creation, updates, or deletions
 */
export const invalidateInstitutionData = (utils: ReturnType<typeof trpc.useUtils>) => {
  utils.institutions.getAll.invalidate();
  utils.institutions.getByUserId.invalidate();
  utils.institutions.getByUserIdWithSummary.invalidate();
  utils.dashboard.getOverview.invalidate();
};
