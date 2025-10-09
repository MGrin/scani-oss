import type { UseTRPCMutationOptions } from '@trpc/react-query/shared';
import type { RouterInputs, RouterOutputs } from '@/lib/api-types';
import {
  prependEntity,
  removeEntity,
  replaceEntity,
  replaceEntityById,
} from '@/lib/cache/optimisticUtils';
import {
  refreshAccountsViews,
  refreshHoldingsViews,
  refreshInstitutionsViews,
  refreshPortfolioValue,
  refreshTokensViews,
  refreshTransactionsViews,
} from '@/lib/cache/refresh';
import type { TrpcUtils } from '@/lib/cache/trpcUtils';

type InstitutionTypeDefinition = RouterOutputs['institutionTypes']['getAll'][number];
type AccountTypeDefinition = RouterOutputs['accountTypes']['getAll'][number];
type TokenTypeDefinition = RouterOutputs['tokenTypes']['getAll'][number];
type HoldingDetail = RouterOutputs['holdings']['getById'];

type MutationContext = {
  tempId?: string;
  institutionsAll?: Institution[];
  institutionsByUser?: Institution[];
  removedInstitution?: Institution;
  accountsAll?: Account[];
  removedAccount?: Account;
  holdingsAll?: Holding[];
  holdingDetail?: HoldingDetail;
  removedHolding?: Holding;
  tokensAll?: Token[];
  tokensByUser?: Token[];
  transactionsAll?: Transaction[];
  removedTransaction?: Transaction;
  previousUser?: RouterOutputs['users']['getCurrent'];
};

type MutationHandlers<TVariables = unknown, TData = unknown, TError = unknown> = Required<
  Pick<
    UseTRPCMutationOptions<TVariables, TData, TError, MutationContext>,
    'onMutate' | 'onError' | 'onSuccess' | 'onSettled'
  >
>;

type HandlerFactory<TVariables, TData = unknown, TError = unknown> = (
  utils: TrpcUtils
) => MutationHandlers<TVariables, TData, TError>;

type EntityType =
  | 'institution'
  | 'account'
  | 'holding'
  | 'token'
  | 'transaction'
  | 'user'
  | 'screenshotProcessing';

type Operation = 'create' | 'update' | 'delete';

type Institution = RouterOutputs['institutions']['getAll'][number];
type Account = RouterOutputs['accounts']['getAll'][number];
type Holding = RouterOutputs['holdings']['getAll'][number];
type Token = RouterOutputs['tokens']['getAll'][number];
type Transaction = RouterOutputs['transactions']['getAll'][number];

type InstitutionCreateInput = RouterInputs['institutions']['create'];
type InstitutionDeleteInput = RouterInputs['institutions']['delete'];
type AccountCreateInput = RouterInputs['accounts']['create'];
type AccountDeleteInput = RouterInputs['accounts']['delete'];
type HoldingCreateInput = RouterInputs['holdings']['create'];
type HoldingUpdateInput = RouterInputs['holdings']['update'];
type HoldingDeleteInput = RouterInputs['holdings']['delete'];
type TokenCreateInput = RouterInputs['tokens']['create'];
type TokenUpdateInput = RouterInputs['tokens']['update'];
type TransactionCreateInput = RouterInputs['transactions']['create'];
type TransactionUpdateInput = RouterInputs['transactions']['update'];
type TransactionDeleteInput = RouterInputs['transactions']['delete'];
type UserUpdateInput = RouterInputs['users']['updateCurrent'];

const asIsoString = (value?: string | Date | null) => {
  if (!value) return new Date().toISOString();
  if (value instanceof Date) return value.toISOString();
  return value;
};

const asStringValue = (value: unknown, fallback = '0') => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toString() : fallback;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return fallback;
};

const normalizeNullable = (value: unknown) =>
  value === undefined || value === '' ? null : (value as string | null);

const createTempId = (prefix: string) =>
  `temp-${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const getAccountFromCache = (utils: TrpcUtils, accountId?: string | null) => {
  if (!accountId) return undefined;
  if (utils.accounts?.getById) {
    const byId = utils.accounts.getById.getData({ id: accountId });
    if (byId) return byId;
  }
  const accountsAll = utils.accounts.getAll.getData();
  return accountsAll?.find((account) => account.id === accountId);
};

const collectInstitutionIds = (utils: TrpcUtils, accountIds: string[]) => {
  const candidate = new Set<string>();
  for (const accountId of accountIds) {
    const account = getAccountFromCache(utils, accountId);
    if (account?.institutionId) {
      candidate.add(account.institutionId);
    }
  }
  return Array.from(candidate);
};

const getInstitutionCreateHandlers = (
  utils: TrpcUtils
): MutationHandlers<InstitutionCreateInput, Institution | null> => ({
  async onMutate(input: InstitutionCreateInput) {
    await Promise.all([
      utils.institutions.getAll.cancel(),
      utils.institutions.getByUserId.cancel(),
    ]);

    const institutionsAll = utils.institutions.getAll.getData();
    const institutionsByUser = utils.institutions.getByUserId.getData();
    const tempId = createTempId('institution');
    const nowIso = new Date().toISOString();

    const typeList: InstitutionTypeDefinition[] = utils.institutionTypes.getAll.getData() ?? [];
    const typeInfo = typeList.find((type) => type.code === input.type);

    const optimistic: Institution = {
      id: tempId,
      name: input.name.trim(),
      typeId: typeInfo?.id ?? tempId,
      type: typeInfo?.code ?? input.type,
      typeName: typeInfo?.name ?? input.type,
      description: normalizeNullable(input.description),
      website: normalizeNullable(input.website),
      logoUrl: normalizeNullable(input.logoUrl),
      isActive: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    } as Institution;

    utils.institutions.getAll.setData(undefined, (current) => prependEntity(current, optimistic));
    utils.institutions.getByUserId.setData(undefined, (current) =>
      prependEntity(current, optimistic)
    );

    return {
      tempId,
      institutionsAll,
      institutionsByUser,
    } satisfies MutationContext;
  },
  async onError(_error, _variables, context) {
    // Rollback optimistic update
    if (context?.institutionsAll) {
      utils.institutions.getAll.setData(undefined, context.institutionsAll);
    }
    if (context?.institutionsByUser) {
      utils.institutions.getByUserId.setData(undefined, context.institutionsByUser);
    }

    // CRITICAL FIX: Refetch to sync with server state after error
    // This ensures cache reflects database truth even if partial operation succeeded
    try {
      await Promise.all([
        utils.institutions.getAll.refetch(),
        utils.institutions.getByUserId.refetch(),
      ]);
    } catch (refetchError) {
      console.error('Failed to refetch institutions after error:', refetchError);
    }
  },
  async onSuccess(result, _variables, context) {
    const created = (result as Institution | null) ?? null;
    if (!created) {
      // Null result means creation failed - remove optimistic entity
      const tempId = context?.tempId;
      if (tempId) {
        utils.institutions.getAll.setData(undefined, (current) => removeEntity(current, tempId));
        utils.institutions.getByUserId.setData(undefined, (current) =>
          removeEntity(current, tempId)
        );
      }
      return;
    }

    const normalized: Institution = {
      ...created,
      description: normalizeNullable(created.description),
      website: normalizeNullable(created.website),
      logoUrl: normalizeNullable(created.logoUrl),
      createdAt: asIsoString(created.createdAt),
      updatedAt: asIsoString(created.updatedAt),
    } as Institution;

    const targetId = context?.tempId ?? normalized.id;

    utils.institutions.getAll.setData(undefined, (current) =>
      replaceEntityById(current, targetId, normalized)
    );
    utils.institutions.getByUserId.setData(undefined, (current) =>
      replaceEntityById(current, targetId, normalized)
    );
  },
  async onSettled(result) {
    const created = result as Partial<Institution> | undefined;
    await refreshInstitutionsViews(utils, {
      institutionIds: created?.id ? [created.id] : [],
      cascadeAccounts: true,
    });
  },
});

const getInstitutionDeleteHandlers = (
  utils: TrpcUtils
): MutationHandlers<InstitutionDeleteInput, RouterOutputs['institutions']['delete']> => ({
  async onMutate(input: InstitutionDeleteInput) {
    await Promise.all([
      utils.institutions.getByUserId.cancel(),
      utils.institutions.getAll.cancel(),
    ]);

    const institutionsByUser = utils.institutions.getByUserId.getData();
    const removedInstitution = institutionsByUser?.find(
      (institution) => institution.id === input.id
    );

    utils.institutions.getByUserId.setData(undefined, (current) => removeEntity(current, input.id));

    return {
      institutionsByUser,
      removedInstitution,
    } satisfies MutationContext;
  },
  async onError(_error, _variables, context) {
    // Rollback optimistic update
    if (context?.institutionsByUser) {
      utils.institutions.getByUserId.setData(undefined, context.institutionsByUser);
    }

    // CRITICAL FIX: Refetch to ensure cache is in sync
    try {
      await Promise.all([
        utils.institutions.getAll.refetch(),
        utils.institutions.getByUserId.refetch(),
      ]);
    } catch (refetchError) {
      console.error('Failed to refetch institutions after delete error:', refetchError);
    }
  },
  async onSuccess(result, _variables, context) {
    const response = result as RouterOutputs['institutions']['delete'] | undefined;
    if (!response?.success && context?.removedInstitution) {
      const removed = context.removedInstitution;
      utils.institutions.getByUserId.setData(undefined, (current) =>
        prependEntity(current, removed)
      );
    }
  },
  async onSettled(result, _error, variables) {
    const response = result as RouterOutputs['institutions']['delete'] | undefined;
    const institutionId = response?.deleted?.id ?? variables.id;
    await Promise.all([
      refreshInstitutionsViews(utils, {
        institutionIds: institutionId ? [institutionId] : [],
        cascadeAccounts: true,
      }),
      refreshTokensViews(utils),
    ]);
  },
});

const getAccountCreateHandlers = (
  utils: TrpcUtils
): MutationHandlers<AccountCreateInput, Account | null> => ({
  async onMutate(input: AccountCreateInput) {
    await Promise.all([utils.accounts.getAll.cancel(), utils.accounts.getSummaries.cancel()]);

    const accountsAll = utils.accounts.getAll.getData();
    const tempId = createTempId('account');
    const nowIso = new Date().toISOString();

    const typeList: AccountTypeDefinition[] = utils.accountTypes.getAll.getData() ?? [];
    const typeInfo = typeList.find((type) => type.code === input.type);

    const optimistic: Account = {
      id: tempId,
      institutionId: input.institutionId,
      name: input.name.trim(),
      typeId: typeInfo?.id ?? tempId,
      type: typeInfo?.code ?? input.type,
      typeName: typeInfo?.name ?? input.type,
      description: normalizeNullable(input.description),
      isActive: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    } as Account;

    utils.accounts.getAll.setData(undefined, (current) => prependEntity(current, optimistic));

    return {
      tempId,
      accountsAll,
    } satisfies MutationContext;
  },
  async onError(_error, _variables, context) {
    // Rollback optimistic update
    if (context?.accountsAll) {
      utils.accounts.getAll.setData(undefined, context.accountsAll);
    }

    // CRITICAL FIX: Refetch to sync with server state
    try {
      await Promise.all([utils.accounts.getAll.refetch(), utils.accounts.getSummaries.refetch()]);
    } catch (refetchError) {
      console.error('Failed to refetch accounts after error:', refetchError);
    }
  },
  async onSuccess(result, _variables, context) {
    const created = result as Account | null;
    if (!created) {
      // Null result means creation failed - remove optimistic entity
      const tempId = context?.tempId;
      if (tempId) {
        utils.accounts.getAll.setData(undefined, (current) => removeEntity(current, tempId));
      }
      return;
    }

    const normalized: Account = {
      ...created,
      description: normalizeNullable(created.description),
      createdAt: asIsoString(created.createdAt),
      updatedAt: asIsoString(created.updatedAt),
    } as Account;

    const targetId = context?.tempId ?? normalized.id;

    utils.accounts.getAll.setData(undefined, (current) =>
      replaceEntityById(current, targetId, normalized)
    );
    utils.accounts.getById.setData({ id: normalized.id }, normalized);
  },
  async onSettled(result, _error, variables) {
    const created = result as Partial<Account> | undefined;
    const accountId = created?.id;
    const institutionId = created?.institutionId ?? variables.institutionId;
    await refreshAccountsViews(utils, {
      accountIds: accountId ? [accountId] : [],
      institutionIds: institutionId ? [institutionId] : [],
      cascadeHoldings: true,
    });
  },
});

const getAccountDeleteHandlers = (
  utils: TrpcUtils
): MutationHandlers<AccountDeleteInput, RouterOutputs['accounts']['delete']> => ({
  async onMutate(input: AccountDeleteInput) {
    await Promise.all([utils.accounts.getAll.cancel(), utils.accounts.getSummaries.cancel()]);

    const accountsAll = utils.accounts.getAll.getData();
    const removedAccount = accountsAll?.find((account) => account.id === input.id);

    utils.accounts.getAll.setData(undefined, (current) => removeEntity(current, input.id));

    return {
      accountsAll,
      removedAccount,
    } satisfies MutationContext;
  },
  async onError(_error, _variables, context) {
    if (context?.accountsAll) {
      utils.accounts.getAll.setData(undefined, context.accountsAll);
    }
  },
  async onSuccess(result, _variables, context) {
    const response = result as RouterOutputs['accounts']['delete'] | undefined;
    if (!response?.success && context?.removedAccount) {
      const removed = context.removedAccount;
      utils.accounts.getAll.setData(undefined, (current) => prependEntity(current, removed));
    }
  },
  async onSettled(result, _error, variables, context) {
    const response = result as RouterOutputs['accounts']['delete'] | undefined;
    const deletedAccount = response?.deleted ?? context?.removedAccount;
    const accountId = deletedAccount?.id ?? variables.id;
    const institutionId = deletedAccount?.institutionId;
    await refreshAccountsViews(utils, {
      accountIds: accountId ? [accountId] : [],
      institutionIds: institutionId ? [institutionId] : [],
      cascadeHoldings: true,
    });
  },
});

const getHoldingCreateHandlers = (
  utils: TrpcUtils
): MutationHandlers<HoldingCreateInput, Holding | null> => ({
  async onMutate(input: HoldingCreateInput) {
    await Promise.all([
      utils.holdings.getAll.cancel(),
      utils.accounts.getSummaries.cancel(),
      utils.users.getPortfolioValue.cancel(),
    ]);

    const holdingsAll = utils.holdings.getAll.getData();
    const tempId = createTempId('holding');
    const nowIso = new Date().toISOString();
    const userId = holdingsAll?.[0]?.userId ?? 'temp-user';

    const optimistic: Holding = {
      id: tempId,
      userId,
      accountId: input.accountId,
      tokenId: input.tokenId,
      balance: asStringValue(input.balance, '0'),
      createdAt: nowIso,
      lastUpdated: asIsoString(input.lastUpdated),
    } as Holding;

    utils.holdings.getAll.setData(undefined, (current) => prependEntity(current, optimistic));

    return {
      tempId,
      holdingsAll,
    } satisfies MutationContext;
  },
  async onError(_error, _variables, context) {
    if (context?.holdingsAll) {
      utils.holdings.getAll.setData(undefined, context.holdingsAll);
    }
  },
  async onSuccess(result, _variables, context) {
    const created = result as Holding | null;
    if (!created) {
      // Null result means creation failed - remove optimistic entity
      const tempId = context?.tempId;
      if (tempId) {
        utils.holdings.getAll.setData(undefined, (current) => removeEntity(current, tempId));
      }
      return;
    }

    const normalized: Holding = {
      ...created,
      balance: asStringValue(created.balance, '0'),
      createdAt: asIsoString(created.createdAt),
      lastUpdated: asIsoString(created.lastUpdated),
    } as Holding;

    const targetId = context?.tempId ?? normalized.id;

    utils.holdings.getAll.setData(undefined, (current) =>
      replaceEntityById(current, targetId, normalized)
    );
    utils.holdings.getById.invalidate({ id: normalized.id });
  },
  async onSettled(result, _error, variables) {
    const created = result as Partial<Holding> | undefined;
    const holdingId = created?.id;
    const accountId = created?.accountId ?? variables.accountId;
    const institutionIds = collectInstitutionIds(utils, accountId ? [accountId] : []);
    await refreshHoldingsViews(utils, {
      holdingIds: holdingId ? [holdingId] : [],
      accountIds: accountId ? [accountId] : [],
      institutionIds,
    });
  },
});

const getHoldingUpdateHandlers = (
  utils: TrpcUtils
): MutationHandlers<HoldingUpdateInput, Holding | null> => ({
  async onMutate(input: HoldingUpdateInput) {
    await Promise.all([
      utils.holdings.getAll.cancel(),
      utils.holdings.getById.cancel({ id: input.id }),
      utils.accounts.getSummaries.cancel(),
      utils.users.getPortfolioValue.cancel(),
    ]);

    const holdingsAll = utils.holdings.getAll.getData();
    const holdingDetail = utils.holdings.getById.getData({ id: input.id }) ?? null;
    const nowIso = new Date().toISOString();

    const sanitizedBalance =
      input.data && 'balance' in input.data ? asStringValue(input.data.balance, '0') : undefined;
    const sanitizedLastUpdated =
      input.data && 'lastUpdated' in input.data ? asIsoString(input.data.lastUpdated) : nowIso;

    utils.holdings.getAll.setData(undefined, (current) => {
      if (!current) return current;
      return current.map((holding) => {
        if (holding.id !== input.id) {
          return holding;
        }

        const updates: Partial<Holding> = {
          ...(input.data as Partial<Holding>),
          lastUpdated: sanitizedLastUpdated,
        };

        if (sanitizedBalance !== undefined) {
          updates.balance = sanitizedBalance;
        }

        return {
          ...holding,
          ...updates,
        };
      });
    });

    const nextAccountId =
      input.data && 'accountId' in input.data ? input.data.accountId : undefined;
    const nextTokenId = input.data && 'tokenId' in input.data ? input.data.tokenId : undefined;

    utils.holdings.getById.setData({ id: input.id }, (current) => {
      if (!current) return current;
      return {
        ...current,
        ...(nextAccountId ? { accountId: nextAccountId } : {}),
        ...(nextTokenId ? { tokenId: nextTokenId } : {}),
      };
    });

    return {
      holdingsAll,
      holdingDetail,
    } satisfies MutationContext;
  },
  async onError(_error, variables, context) {
    if (context?.holdingsAll) {
      utils.holdings.getAll.setData(undefined, context.holdingsAll);
    }
    if (context?.holdingDetail) {
      utils.holdings.getById.setData({ id: variables.id }, context.holdingDetail);
    }
  },
  async onSuccess(result) {
    const updated = result as Holding | null;
    if (!updated) return;

    const normalized: Holding = {
      ...updated,
      balance: asStringValue(updated.balance, '0'),
      createdAt: asIsoString(updated.createdAt),
      lastUpdated: asIsoString(updated.lastUpdated),
    } as Holding;

    utils.holdings.getAll.setData(undefined, (current) => replaceEntity(current, normalized));
    utils.holdings.getById.invalidate({ id: normalized.id });
  },
  async onSettled(result, _error, variables, context) {
    const updated = result as Partial<Holding> | undefined;
    const holdingId = updated?.id ?? variables.id;
    const previousDetail = context?.holdingDetail ?? undefined;
    const candidateAccountIds = new Set<string>();

    if (updated?.accountId) {
      candidateAccountIds.add(updated.accountId);
    }

    const inputAccountId = (variables.data as { accountId?: string } | undefined)?.accountId;
    if (inputAccountId) {
      candidateAccountIds.add(inputAccountId);
    }

    if (previousDetail?.accountId) {
      candidateAccountIds.add(previousDetail.accountId);
    }

    const accountIds = Array.from(candidateAccountIds);
    const institutionIds = collectInstitutionIds(utils, accountIds);

    await refreshHoldingsViews(utils, {
      holdingIds: holdingId ? [holdingId] : [],
      accountIds,
      institutionIds,
    });
  },
});

const getHoldingDeleteHandlers = (
  utils: TrpcUtils
): MutationHandlers<HoldingDeleteInput, RouterOutputs['holdings']['delete']> => ({
  async onMutate(input: HoldingDeleteInput) {
    await Promise.all([
      utils.holdings.getAll.cancel(),
      utils.accounts.getSummaries.cancel(),
      utils.users.getPortfolioValue.cancel(),
    ]);

    const holdingsAll = utils.holdings.getAll.getData();
    const holdingDetail = utils.holdings.getById.getData({ id: input.id }) ?? null;
    const removedHolding = holdingsAll?.find((holding) => holding.id === input.id);

    utils.holdings.getAll.setData(undefined, (current) => removeEntity(current, input.id));
    utils.holdings.getById.setData({ id: input.id }, undefined);

    return {
      holdingsAll,
      holdingDetail,
      removedHolding,
    } satisfies MutationContext;
  },
  async onError(_error, _variables, context) {
    if (context?.holdingsAll) {
      utils.holdings.getAll.setData(undefined, context.holdingsAll);
    }
    if (context?.holdingDetail) {
      utils.holdings.getById.setData({ id: context.holdingDetail.id }, context.holdingDetail);
    }
  },
  async onSuccess(result, _variables, context) {
    const response = result as RouterOutputs['holdings']['delete'] | undefined;
    if (!response?.success && context?.removedHolding) {
      const removed = context.removedHolding;
      utils.holdings.getAll.setData(undefined, (current) => prependEntity(current, removed));
      utils.holdings.getById.setData({ id: removed.id }, context.holdingDetail ?? null);
    }
  },
  async onSettled(result, _error, variables, context) {
    const response = result as RouterOutputs['holdings']['delete'] | undefined;
    const deletedHolding = response?.deleted ?? context?.removedHolding;
    const holdingId = deletedHolding?.id ?? variables.id;
    const accountId = deletedHolding?.accountId;
    const institutionIds = collectInstitutionIds(utils, accountId ? [accountId] : []);
    utils.holdings.getById.invalidate({ id: holdingId });
    await refreshHoldingsViews(utils, {
      holdingIds: holdingId ? [holdingId] : [],
      accountIds: accountId ? [accountId] : [],
      institutionIds,
    });
  },
});

const getTokenCreateHandlers = (
  utils: TrpcUtils
): MutationHandlers<TokenCreateInput, Token | null> => ({
  async onMutate(input: TokenCreateInput) {
    await Promise.all([utils.tokens.getAll.cancel(), utils.tokens.getByUserId.cancel()]);

    const tokensAll = utils.tokens.getAll.getData();
    const tokensByUser = utils.tokens.getByUserId.getData();
    const tempId = createTempId('token');
    const nowIso = new Date().toISOString();

    const typeList: TokenTypeDefinition[] = utils.tokenTypes.getAll.getData() ?? [];
    const typeMatch = typeList.find(
      (type) => type.code === input.typeId || type.id === input.typeId
    );

    const optimistic: Token = {
      id: tempId,
      symbol: input.symbol.trim().toUpperCase(),
      name: (input.name ?? input.symbol).trim(),
      typeId: typeMatch?.id ?? (typeof input.typeId === 'string' ? input.typeId : tempId),
      type: typeMatch?.code ?? (typeof input.typeId === 'string' ? input.typeId : null),
      typeName: typeMatch?.name ?? typeMatch?.code ?? null,
      decimals: 'decimals' in input && input.decimals !== undefined ? input.decimals : 2,
      iconUrl: normalizeNullable(input.iconUrl),
      isActive: true,
      createdAt: nowIso,
      updatedAt: nowIso,
    } as Token;

    utils.tokens.getAll.setData(undefined, (current) => prependEntity(current, optimistic));

    return {
      tempId,
      tokensAll,
      tokensByUser,
    } satisfies MutationContext;
  },
  async onError(_error, _variables, context) {
    if (context?.tokensAll) {
      utils.tokens.getAll.setData(undefined, context.tokensAll);
    }
    if (context?.tokensByUser) {
      utils.tokens.getByUserId.setData(undefined, context.tokensByUser);
    }
  },
  async onSuccess(result, variables, context) {
    const created = result as Token | null;
    if (!created) {
      // Null result means creation failed - remove optimistic entity
      const tempId = context?.tempId;
      if (tempId) {
        utils.tokens.getAll.setData(undefined, (current) => removeEntity(current, tempId));
      }
      return;
    }

    const normalized: Token = {
      ...created,
      symbol: created.symbol ?? variables.symbol.toUpperCase(),
      name: created.name ?? variables.name ?? variables.symbol.toUpperCase(),
      typeId:
        created.typeId ??
        (typeof variables.typeId === 'string' ? variables.typeId : createTempId('token-type')),
      type: created.type ?? null,
      typeName: created.typeName ?? created.type ?? null,
      iconUrl: normalizeNullable(created.iconUrl),
      createdAt: asIsoString(created.createdAt),
      updatedAt: asIsoString(created.updatedAt),
    } as Token;

    const targetId = context?.tempId ?? normalized.id;

    utils.tokens.getAll.setData(undefined, (current) =>
      replaceEntityById(current, targetId, normalized)
    );
  },
  async onSettled() {
    await refreshTokensViews(utils);
  },
});

const getTokenUpdateHandlers = (
  utils: TrpcUtils
): MutationHandlers<TokenUpdateInput, Token | null> => ({
  async onMutate(input: TokenUpdateInput) {
    await Promise.all([utils.tokens.getAll.cancel(), utils.tokens.getByUserId.cancel()]);

    const tokensAll = utils.tokens.getAll.getData();
    const nowIso = new Date().toISOString();

    utils.tokens.getAll.setData(undefined, (current) =>
      (current ?? []).map((token) =>
        token.id === input.id
          ? {
              ...token,
              ...(input.data as Partial<Token>),
              updatedAt: nowIso,
            }
          : token
      )
    );

    return {
      tokensAll,
    } satisfies MutationContext;
  },
  async onError(_error, variables, context) {
    if (context?.tokensAll) {
      utils.tokens.getAll.setData(undefined, context.tokensAll);
    }
    utils.tokens.getById.invalidate({ id: variables.id });
  },
  async onSuccess(result) {
    const updated = result as Token | null;
    if (!updated) return;

    const normalized: Token = {
      ...updated,
      iconUrl: normalizeNullable(updated.iconUrl),
      createdAt: asIsoString(updated.createdAt),
      updatedAt: asIsoString(updated.updatedAt),
    } as Token;

    utils.tokens.getAll.setData(undefined, (current) => replaceEntity(current, normalized));
    utils.tokens.getById.setData({ id: normalized.id }, normalized);
  },
  async onSettled(result, _error, variables) {
    const updated = result as Partial<Token> | undefined;
    const tokenId = updated?.id ?? variables.id;
    await refreshTokensViews(utils);
    if (tokenId) {
      utils.tokens.getById.invalidate({ id: tokenId });
    }
  },
});

const getTransactionCreateHandlers = (
  utils: TrpcUtils
): MutationHandlers<TransactionCreateInput, Transaction | null> => ({
  async onMutate(variables: TransactionCreateInput) {
    await utils.transactions.getAll.cancel();
    const transactionsAll = utils.transactions.getAll.getData();
    const tempId = createTempId('transaction');
    const nowIso = new Date().toISOString();

    const optimistic: Transaction = {
      id: tempId,
      holdingId: variables.holdingId,
      typeId: 'temp-type',
      type: variables.type ?? 'other',
      typeName: variables.type ?? 'other',
      amount: asStringValue(variables.amount, '0'),
      fee: asStringValue(variables.fee, '0'),
      feeTokenId: normalizeNullable(variables.feeTokenId),
      description: normalizeNullable(variables.description),
      reference: normalizeNullable(variables.reference),
      timestamp: asIsoString(variables.timestamp),
      createdAt: nowIso,
      updatedAt: nowIso,
      baseCurrencyAmount: asStringValue(variables.amount, '0'),
      baseCurrencyFee: asStringValue(variables.fee, '0'),
      baseCurrencySymbol: 'USD',
    } as Transaction;

    utils.transactions.getAll.setData(undefined, (current) => prependEntity(current, optimistic));

    return {
      tempId,
      transactionsAll,
    } satisfies MutationContext;
  },
  async onError(_error, _variables, context) {
    if (context?.transactionsAll) {
      utils.transactions.getAll.setData(undefined, context.transactionsAll);
    }
  },
  async onSuccess(result, _variables, context) {
    const created = result as Transaction | null;
    if (!created) {
      // Null result means creation failed - remove optimistic entity
      const tempId = context?.tempId;
      if (tempId) {
        utils.transactions.getAll.setData(undefined, (current) => removeEntity(current, tempId));
      }
      return;
    }

    const normalized: Transaction = {
      ...created,
      amount: asStringValue(created.amount, '0'),
      fee: asStringValue(created.fee, '0'),
      timestamp: asIsoString(created.timestamp),
      createdAt: asIsoString(created.createdAt),
      updatedAt: asIsoString(created.updatedAt),
    } as Transaction;

    const targetId = context?.tempId ?? normalized.id;

    utils.transactions.getAll.setData(undefined, (current) =>
      replaceEntityById(current, targetId, normalized)
    );
  },
  async onSettled(result, _error, variables) {
    const created = result as Partial<Transaction> | undefined;
    const holdingId = created?.holdingId ?? variables.holdingId;
    await refreshTransactionsViews(utils, {
      holdingIds: holdingId ? [holdingId] : [],
    });
  },
});

const getTransactionUpdateHandlers = (
  utils: TrpcUtils
): MutationHandlers<TransactionUpdateInput, Transaction | null> => ({
  async onMutate(input: TransactionUpdateInput) {
    await utils.transactions.getAll.cancel();
    const transactionsAll = utils.transactions.getAll.getData();
    const nowIso = new Date().toISOString();

    const sanitizedAmount =
      input.data && 'amount' in input.data ? asStringValue(input.data.amount, '0') : undefined;
    const sanitizedFee =
      input.data && 'fee' in input.data ? asStringValue(input.data.fee, '0') : undefined;
    const sanitizedTimestamp =
      input.data && 'timestamp' in input.data ? asIsoString(input.data.timestamp) : undefined;

    utils.transactions.getAll.setData(undefined, (current) =>
      (current ?? []).map((transaction) =>
        transaction.id === input.id
          ? ({
              ...transaction,
              ...(input.data as Partial<Transaction>),
              amount: sanitizedAmount ?? transaction.amount,
              fee: sanitizedFee ?? transaction.fee,
              timestamp: sanitizedTimestamp ?? transaction.timestamp,
              updatedAt: nowIso,
            } as Transaction)
          : transaction
      )
    );

    return {
      transactionsAll,
    } satisfies MutationContext;
  },
  async onError(_error, variables, context) {
    if (context?.transactionsAll) {
      utils.transactions.getAll.setData(undefined, context.transactionsAll);
    }
    utils.transactions.getById?.invalidate?.({ id: variables.id });
  },
  async onSuccess(result) {
    const updated = result as Transaction | null;
    if (!updated) return;

    const normalized: Transaction = {
      ...updated,
      amount: asStringValue(updated.amount, '0'),
      fee: asStringValue(updated.fee, '0'),
      timestamp: asIsoString(updated.timestamp),
      createdAt: asIsoString(updated.createdAt),
      updatedAt: asIsoString(updated.updatedAt),
    } as Transaction;

    utils.transactions.getAll.setData(undefined, (current) => replaceEntity(current, normalized));
  },
  async onSettled(result, _error, variables, context) {
    const updated = result as Partial<Transaction> | undefined;
    const candidateHoldingIds = new Set<string>();

    if (updated?.holdingId) {
      candidateHoldingIds.add(updated.holdingId);
    }

    const inputHoldingId = (variables.data as { holdingId?: string } | undefined)?.holdingId;
    if (inputHoldingId) {
      candidateHoldingIds.add(inputHoldingId);
    }

    const previousTransactions = context?.transactionsAll;
    const previousHoldingId = previousTransactions?.find(
      (transaction) => transaction.id === variables.id
    )?.holdingId;
    if (previousHoldingId) {
      candidateHoldingIds.add(previousHoldingId);
    }

    await refreshTransactionsViews(utils, {
      holdingIds: Array.from(candidateHoldingIds),
    });
  },
});

const getTransactionDeleteHandlers = (
  utils: TrpcUtils
): MutationHandlers<TransactionDeleteInput, RouterOutputs['transactions']['delete']> => ({
  async onMutate(input: TransactionDeleteInput) {
    await utils.transactions.getAll.cancel();
    const transactionsAll = utils.transactions.getAll.getData();
    const removedTransaction = transactionsAll?.find((transaction) => transaction.id === input.id);

    utils.transactions.getAll.setData(undefined, (current) => removeEntity(current, input.id));

    return {
      transactionsAll,
      removedTransaction,
    } satisfies MutationContext;
  },
  async onError(_error, _variables, context) {
    if (context?.transactionsAll) {
      utils.transactions.getAll.setData(undefined, context.transactionsAll);
    }
    if (context?.removedTransaction) {
      const removed = context.removedTransaction;
      utils.transactions.getAll.setData(undefined, (current) => prependEntity(current, removed));
    }
  },
  async onSuccess(result, variables) {
    const response = result as RouterOutputs['transactions']['delete'] | undefined;
    const transactionId = response?.deleted?.id ?? variables.id;

    utils.transactions.getAll.setData(undefined, (current) => removeEntity(current, transactionId));
  },
  async onSettled(result, _error, variables, context) {
    const response = result as RouterOutputs['transactions']['delete'] | undefined;
    const deletedTransaction = response?.deleted ?? context?.removedTransaction;
    const holdingId = deletedTransaction?.holdingId;

    if (!response?.deleted) {
      const transactionId = deletedTransaction?.id ?? variables.id;
      utils.transactions.getAll.setData(undefined, (current) =>
        removeEntity(current, transactionId)
      );
    }

    await refreshTransactionsViews(utils, {
      holdingIds: holdingId ? [holdingId] : [],
    });
  },
});

const getUserUpdateHandlers = (
  utils: TrpcUtils
): MutationHandlers<UserUpdateInput, RouterOutputs['users']['updateCurrent']> => ({
  async onMutate(input: UserUpdateInput) {
    await utils.users.getCurrent.cancel();
    await utils.users.getPortfolioValue.cancel();

    const previousUser = utils.users.getCurrent.getData();

    utils.users.getCurrent.setData(undefined, (current) =>
      current
        ? {
            ...current,
            ...input,
            updatedAt: new Date().toISOString(),
          }
        : current
    );

    return {
      previousUser,
    } satisfies MutationContext;
  },
  async onError(_error, _variables, context) {
    if (context?.previousUser) {
      utils.users.getCurrent.setData(undefined, context.previousUser);
    }
  },
  async onSuccess(result) {
    if (result) {
      utils.users.getCurrent.setData(undefined, result as RouterOutputs['users']['getCurrent']);
    }
  },
  async onSettled() {
    await refreshPortfolioValue(utils);
  },
});

const handlerFactories: Partial<
  Record<
    EntityType,
    Partial<
      Record<
        Operation,
        HandlerFactory<
          RouterInputs[EntityType extends keyof RouterInputs
            ? EntityType
            : never][Operation extends keyof RouterInputs[EntityType extends keyof RouterInputs
            ? EntityType
            : never]
            ? Operation
            : never],
          RouterOutputs[EntityType extends keyof RouterOutputs
            ? EntityType
            : never][Operation extends keyof RouterOutputs[EntityType extends keyof RouterOutputs
            ? EntityType
            : never]
            ? Operation
            : never]
        >
      >
    >
  >
> = {
  institution: {
    create: getInstitutionCreateHandlers,
    delete: getInstitutionDeleteHandlers,
  },
  account: {
    create: getAccountCreateHandlers,
    delete: getAccountDeleteHandlers,
  },
  holding: {
    create: getHoldingCreateHandlers,
    update: getHoldingUpdateHandlers,
    delete: getHoldingDeleteHandlers,
  },
  token: {
    create: getTokenCreateHandlers,
    update: getTokenUpdateHandlers,
  },
  transaction: {
    create: getTransactionCreateHandlers,
    update: getTransactionUpdateHandlers,
    delete: getTransactionDeleteHandlers,
  },
  user: {
    update: getUserUpdateHandlers,
  },
};

export const withOptimisticHandlers = <TInput, TOutput, TError = unknown>(
  entity: EntityType,
  operation: Operation,
  utils: TrpcUtils,
  overrides?: Partial<MutationHandlers<TInput, TOutput, TError>>
): UseTRPCMutationOptions<TInput, TOutput, TError, MutationContext> => {
  const factory = handlerFactories[entity]?.[operation] as
    | HandlerFactory<TInput, TOutput, TError>
    | undefined;
  const baseHandlers = factory ? factory(utils) : undefined;

  return {
    async onMutate(variables) {
      const baseResult = baseHandlers?.onMutate
        ? await baseHandlers.onMutate(variables)
        : ({} as MutationContext);
      const overrideResult = overrides?.onMutate
        ? await overrides.onMutate(variables)
        : ({} as MutationContext);

      return {
        ...baseResult,
        ...overrideResult,
      } as MutationContext;
    },
    async onError(error, variables, context) {
      if (baseHandlers?.onError) {
        await baseHandlers.onError(error, variables, context ?? {});
      }
      if (overrides?.onError) {
        await overrides.onError(error, variables, context ?? {});
      }
    },
    async onSuccess(data, variables, context) {
      if (baseHandlers?.onSuccess) {
        await baseHandlers.onSuccess(data, variables, context ?? {});
      }
      if (overrides?.onSuccess) {
        await overrides.onSuccess(data, variables, context ?? {});
      }
    },
    async onSettled(data, error, variables, context) {
      if (baseHandlers?.onSettled) {
        await baseHandlers.onSettled(data, error, variables, context ?? {});
      }
      if (overrides?.onSettled) {
        await overrides.onSettled(data, error, variables, context ?? {});
      }
    },
  };
};
