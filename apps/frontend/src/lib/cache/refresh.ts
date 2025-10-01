import {
  invalidateAccountsRelated,
  invalidateHoldingsRelated,
  invalidateInstitutionsRelated,
  invalidatePortfolioValue,
  invalidateTokensRelated,
  invalidateTransactionsRelated,
} from './invalidation';
import type { TrpcUtils } from './trpcUtils';

const collectTasks = (tasks: Array<Promise<unknown>>) => Promise.all(tasks).then(() => undefined);

const safeRefetch = (fn?: () => Promise<unknown>) => (fn ? fn() : Promise.resolve(undefined));

export interface InstitutionRefreshOptions {
  institutionIds?: string[];
  cascadeAccounts?: boolean;
}

export function refreshInstitutionsViews(
  utils: TrpcUtils,
  { institutionIds = [], cascadeAccounts = false }: InstitutionRefreshOptions = {}
) {
  // Only invalidate queries, don't force refetch
  const tasks: Array<Promise<unknown>> = [
    invalidateInstitutionsRelated(utils, {
      institutionIds,
      includeAccounts: cascadeAccounts,
      includeByUser: true,
    }),
  ];

  if (cascadeAccounts) {
    tasks.push(
      invalidateAccountsRelated(utils, {
        includeSummaries: true,
        includePortfolioValue: true,
      })
    );
    tasks.push(
      invalidateHoldingsRelated(utils, {
        includeAccountSummaries: false,
        includePortfolioValue: true,
      })
    );
    tasks.push(invalidateTokensRelated(utils));
    tasks.push(invalidateTransactionsRelated(utils));
  }

  return collectTasks(tasks);
}

export interface AccountRefreshOptions {
  accountIds?: string[];
  institutionIds?: string[];
  cascadeHoldings?: boolean;
}

export function refreshAccountsViews(
  utils: TrpcUtils,
  { accountIds = [], institutionIds = [], cascadeHoldings = true }: AccountRefreshOptions = {}
) {
  // Only invalidate queries, don't force refetch
  const tasks: Array<Promise<unknown>> = [
    invalidateAccountsRelated(utils, {
      accountIds,
      includeSummaries: true,
      includePortfolioValue: true,
    }),
  ];

  if (institutionIds.length > 0) {
    tasks.push(
      invalidateInstitutionsRelated(utils, {
        institutionIds,
        includeAccounts: true,
        includeByUser: true,
      })
    );
  }

  if (cascadeHoldings) {
    tasks.push(
      invalidateHoldingsRelated(utils, {
        includeAccountSummaries: false,
        includePortfolioValue: true,
      })
    );
    tasks.push(invalidateTokensRelated(utils));
    tasks.push(invalidateTransactionsRelated(utils));
  }

  return collectTasks(tasks);
}

export interface HoldingRefreshOptions {
  holdingIds?: string[];
  accountIds?: string[];
  institutionIds?: string[];
  cascadeTransactions?: boolean;
}

export function refreshHoldingsViews(
  utils: TrpcUtils,
  {
    holdingIds = [],
    accountIds = [],
    institutionIds = [],
    cascadeTransactions = false,
  }: HoldingRefreshOptions = {}
) {
  // Invalidate all related queries
  const tasks: Array<Promise<unknown>> = [
    invalidateHoldingsRelated(utils, {
      holdingIds,
      includeAccountSummaries: false,
      includePortfolioValue: true,
    }),
    invalidateAccountsRelated(utils, {
      accountIds,
      includeSummaries: true,
      includePortfolioValue: true,
    }),
    invalidateTokensRelated(utils),
  ];

  // Refetch core queries that EntityDataContext and other pages depend on
  // These need to be fresh for navigation to work properly
  tasks.push(safeRefetch(utils.holdings.getAll.refetch));
  tasks.push(safeRefetch(utils.accounts.getAll.refetch));
  tasks.push(safeRefetch(utils.tokens.getAll.refetch));
  // Also refetch tokens.getByUserId which is used by Holdings page
  if (utils.tokens.getByUserId) {
    tasks.push(safeRefetch(utils.tokens.getByUserId.refetch));
  }

  if (institutionIds.length > 0) {
    tasks.push(
      invalidateInstitutionsRelated(utils, {
        institutionIds,
        includeAccounts: true,
        includeByUser: true,
      })
    );
    tasks.push(safeRefetch(utils.institutions.getAll.refetch));
  }

  if (cascadeTransactions) {
    tasks.push(invalidateTransactionsRelated(utils));
  }

  return collectTasks(tasks);
}

export interface TokenRefreshOptions {
  cascadeHoldings?: boolean;
}

export function refreshTokensViews(
  utils: TrpcUtils,
  { cascadeHoldings = true }: TokenRefreshOptions = {}
) {
  // Only invalidate queries, don't force refetch
  const tasks: Array<Promise<unknown>> = [invalidateTokensRelated(utils)];

  if (cascadeHoldings) {
    tasks.push(
      invalidateHoldingsRelated(utils, {
        includeAccountSummaries: false,
        includePortfolioValue: true,
      })
    );
    tasks.push(
      invalidateAccountsRelated(utils, {
        includeSummaries: true,
        includePortfolioValue: true,
      })
    );
    tasks.push(safeRefetch(utils.holdings.getAll.refetch));
    tasks.push(safeRefetch(utils.holdings.getUnpriceableTokens.refetch));
    tasks.push(safeRefetch(utils.accounts.getAll.refetch));
    tasks.push(safeRefetch(utils.accounts.getSummaries.refetch));
    tasks.push(safeRefetch(utils.users.getPortfolioValue.refetch));
  }

  return collectTasks(tasks);
}

export interface TransactionRefreshOptions {
  holdingIds?: string[];
}

export function refreshTransactionsViews(
  utils: TrpcUtils,
  { holdingIds = [] }: TransactionRefreshOptions = {}
) {
  // Only invalidate queries, don't force refetch
  const tasks: Array<Promise<unknown>> = [invalidateTransactionsRelated(utils)];

  if (holdingIds.length > 0) {
    tasks.push(
      invalidateHoldingsRelated(utils, {
        holdingIds,
        includeAccountSummaries: true,
        includePortfolioValue: true,
      })
    );
  }

  return collectTasks(tasks);
}

export function refreshPortfolioValue(utils: TrpcUtils) {
  // Only invalidate, don't force refetch
  return collectTasks([invalidatePortfolioValue(utils)]);
}
