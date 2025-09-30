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
  const tasks: Array<Promise<unknown>> = [
    invalidateInstitutionsRelated(utils, {
      institutionIds,
      includeAccounts: cascadeAccounts,
      includeByUser: true,
    }),
    safeRefetch(utils.institutions.getAll.refetch),
    safeRefetch(utils.institutions.getByUserId?.refetch),
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

    tasks.push(safeRefetch(utils.accounts.getAll.refetch));
    tasks.push(safeRefetch(utils.accounts.getSummaries.refetch));
    tasks.push(safeRefetch(utils.holdings.getAll.refetch));
    tasks.push(safeRefetch(utils.holdings.getUnpriceableTokens.refetch));
    tasks.push(safeRefetch(utils.users.getPortfolioValue.refetch));
    tasks.push(safeRefetch(utils.tokens.getAll.refetch));
    tasks.push(safeRefetch(utils.tokens.getByUserId.refetch));
    tasks.push(safeRefetch(utils.tokens.getWithTotalValues?.refetch));
    tasks.push(safeRefetch(utils.transactions.getAll?.refetch));
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
  const tasks: Array<Promise<unknown>> = [
    invalidateAccountsRelated(utils, {
      accountIds,
      includeSummaries: true,
      includePortfolioValue: true,
    }),
    safeRefetch(utils.accounts.getAll.refetch),
    safeRefetch(utils.accounts.getSummaries.refetch),
  ];

  if (institutionIds.length > 0) {
    tasks.push(
      invalidateInstitutionsRelated(utils, {
        institutionIds,
        includeAccounts: true,
        includeByUser: true,
      })
    );
    tasks.push(safeRefetch(utils.institutions.getAll.refetch));
    tasks.push(safeRefetch(utils.institutions.getByUserId?.refetch));
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

    tasks.push(safeRefetch(utils.holdings.getAll.refetch));
    tasks.push(safeRefetch(utils.holdings.getUnpriceableTokens.refetch));
    tasks.push(safeRefetch(utils.users.getPortfolioValue.refetch));
    tasks.push(safeRefetch(utils.tokens.getAll.refetch));
    tasks.push(safeRefetch(utils.tokens.getByUserId.refetch));
    tasks.push(safeRefetch(utils.tokens.getWithTotalValues?.refetch));
    tasks.push(safeRefetch(utils.transactions.getAll?.refetch));
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
    safeRefetch(utils.holdings.getAll.refetch),
    safeRefetch(utils.holdings.getUnpriceableTokens.refetch),
    safeRefetch(utils.accounts.getAll.refetch),
    safeRefetch(utils.accounts.getSummaries.refetch),
    safeRefetch(utils.tokens.getAll.refetch),
    safeRefetch(utils.tokens.getByUserId.refetch),
    safeRefetch(utils.tokens.getWithTotalValues?.refetch),
    safeRefetch(utils.users.getPortfolioValue.refetch),
  ];

  if (institutionIds.length > 0) {
    tasks.push(
      invalidateInstitutionsRelated(utils, {
        institutionIds,
        includeAccounts: true,
        includeByUser: true,
      })
    );
    tasks.push(safeRefetch(utils.institutions.getAll.refetch));
    tasks.push(safeRefetch(utils.institutions.getByUserId?.refetch));
  }

  if (cascadeTransactions) {
    tasks.push(invalidateTransactionsRelated(utils));
    tasks.push(safeRefetch(utils.transactions.getAll?.refetch));
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
  const tasks: Array<Promise<unknown>> = [
    invalidateTokensRelated(utils),
    safeRefetch(utils.tokens.getAll.refetch),
    safeRefetch(utils.tokens.getByUserId.refetch),
    safeRefetch(utils.tokens.getWithTotalValues?.refetch),
  ];

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
  const tasks: Array<Promise<unknown>> = [
    invalidateTransactionsRelated(utils),
    safeRefetch(utils.transactions.getAll?.refetch),
  ];

  if (holdingIds.length > 0) {
    tasks.push(
      invalidateHoldingsRelated(utils, {
        holdingIds,
        includeAccountSummaries: true,
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

export function refreshPortfolioValue(utils: TrpcUtils) {
  return collectTasks([
    invalidatePortfolioValue(utils),
    safeRefetch(utils.users.getPortfolioValue.refetch),
  ]);
}
