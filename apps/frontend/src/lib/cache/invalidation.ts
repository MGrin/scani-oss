import type { TrpcUtils } from './trpcUtils';

type InvalidationTask = Promise<unknown>;

const runInvalidations = (tasks: InvalidationTask[]) => Promise.all(tasks);

export interface HoldingsInvalidationOptions {
  includeList?: boolean;
  includeUnpriceable?: boolean;
  includeAccountSummaries?: boolean;
  includePortfolioValue?: boolean;
  holdingIds?: string[];
}

export function invalidateHoldingsRelated(
  utils: TrpcUtils,
  {
    includeList = true,
    includeUnpriceable = true,
    includeAccountSummaries = true,
    includePortfolioValue = true,
    holdingIds = [],
  }: HoldingsInvalidationOptions = {}
) {
  const tasks: InvalidationTask[] = [];

  if (includeList) {
    tasks.push(utils.holdings.getAll.invalidate());
  }

  if (includeUnpriceable) {
    tasks.push(utils.holdings.getUnpriceableTokens.invalidate());
  }

  if (includeAccountSummaries) {
    tasks.push(utils.accounts.getSummaries.invalidate());
  }

  if (includePortfolioValue) {
    tasks.push(utils.users.getPortfolioValue.invalidate());
  }

  if (holdingIds.length && utils.holdings.getById) {
    for (const holdingId of holdingIds) {
      tasks.push(utils.holdings.getById.invalidate({ id: holdingId }));
    }
  }

  return runInvalidations(tasks);
}

export interface AccountsInvalidationOptions {
  includeList?: boolean;
  includeSummaries?: boolean;
  includePortfolioValue?: boolean;
  accountIds?: string[];
}

export function invalidateAccountsRelated(
  utils: TrpcUtils,
  {
    includeList = true,
    includeSummaries = true,
    includePortfolioValue = false,
    accountIds = [],
  }: AccountsInvalidationOptions = {}
) {
  const tasks: InvalidationTask[] = [];

  if (includeList) {
    tasks.push(utils.accounts.getAll.invalidate());
  }

  if (includeSummaries) {
    tasks.push(utils.accounts.getSummaries.invalidate());
  }

  if (includePortfolioValue) {
    tasks.push(utils.users.getPortfolioValue.invalidate());
  }

  if (accountIds.length && utils.accounts.getById) {
    for (const accountId of accountIds) {
      tasks.push(utils.accounts.getById.invalidate({ id: accountId }));
    }
  }

  return runInvalidations(tasks);
}

export interface InstitutionsInvalidationOptions {
  includeList?: boolean;
  includeAccounts?: boolean;
  includeByUser?: boolean;
  institutionIds?: string[];
}

export function invalidateInstitutionsRelated(
  utils: TrpcUtils,
  {
    includeList = true,
    includeAccounts = false,
    includeByUser = true,
    institutionIds = [],
  }: InstitutionsInvalidationOptions = {}
) {
  const tasks: InvalidationTask[] = [];

  if (includeList) {
    tasks.push(utils.institutions.getAll.invalidate());
  }

  if (includeByUser && utils.institutions.getByUserId) {
    tasks.push(utils.institutions.getByUserId.invalidate());
  }

  if (includeAccounts) {
    tasks.push(
      runInvalidations([
        utils.accounts.getAll.invalidate(),
        utils.accounts.getSummaries.invalidate(),
      ])
    );
  }

  if (institutionIds.length && utils.institutions.getById) {
    for (const institutionId of institutionIds) {
      tasks.push(utils.institutions.getById.invalidate({ id: institutionId }));
    }
  }

  return runInvalidations(tasks);
}

export interface TokensInvalidationOptions {
  includeList?: boolean;
  includeWithTotals?: boolean;
  includeByUser?: boolean;
  includeSearch?: boolean;
}

export function invalidateTokensRelated(
  utils: TrpcUtils,
  {
    includeList = true,
    includeWithTotals = true,
    includeByUser = true,
    includeSearch = true,
  }: TokensInvalidationOptions = {}
) {
  const tasks: InvalidationTask[] = [];

  if (includeList) {
    tasks.push(utils.tokens.getAll.invalidate());
  }

  if (includeWithTotals && utils.tokens.getWithTotalValues) {
    tasks.push(utils.tokens.getWithTotalValues.invalidate());
  }

  if (includeByUser && utils.tokens.getByUserId) {
    tasks.push(utils.tokens.getByUserId.invalidate());
  }

  if (includeSearch && utils.tokens.search) {
    tasks.push(utils.tokens.search.invalidate());
  }

  return runInvalidations(tasks);
}

export interface TransactionsInvalidationOptions {
  includeList?: boolean;
}

export function invalidateTransactionsRelated(
  utils: TrpcUtils,
  { includeList = true }: TransactionsInvalidationOptions = {}
) {
  const tasks: InvalidationTask[] = [];

  if (includeList && utils.transactions?.getAll) {
    tasks.push(utils.transactions.getAll.invalidate());
  }

  return runInvalidations(tasks);
}

export function invalidatePortfolioValue(utils: TrpcUtils) {
  return utils.users.getPortfolioValue.invalidate();
}
