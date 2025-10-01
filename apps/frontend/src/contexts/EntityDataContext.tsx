import { createContext, type ReactNode, useCallback, useContext, useMemo } from 'react';
import type {
  ApiAccount,
  ApiAccountType,
  ApiInstitution,
  ApiInstitutionType,
  ApiToken,
  ApiTokenType,
} from '@/lib/api-types';
import { trpc } from '@/lib/trpc';

type EntityQueryState<TData> = {
  data: TData[];
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  refetch: () => Promise<unknown>;
};

interface EntityDataContextValue {
  accounts: EntityQueryState<ApiAccount>;
  accountTypes: EntityQueryState<ApiAccountType>;
  institutions: EntityQueryState<ApiInstitution>;
  institutionTypes: EntityQueryState<ApiInstitutionType>;
  tokens: EntityQueryState<ApiToken>;
  tokenTypes: EntityQueryState<ApiTokenType>;
  isReady: boolean;
  refreshAll: () => Promise<void>;
}

const EntityDataContext = createContext<EntityDataContextValue | null>(null);

const DEFAULT_QUERY_OPTIONS = {
  staleTime: 1000 * 60 * 5, // 5 minutes
  gcTime: 1000 * 60 * 10, // 10 minutes (formerly cacheTime)
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
  refetchOnMount: false, // Don't refetch on mount - handled by selective refetch in mutations
  retry: 1, // Only retry once on failure
};

export function EntityDataProvider({ children }: { children: ReactNode }) {
  const accountsQuery = trpc.accounts.getAll.useQuery(undefined, DEFAULT_QUERY_OPTIONS);
  const accountTypesQuery = trpc.accountTypes.getAll.useQuery(undefined, DEFAULT_QUERY_OPTIONS);
  const institutionsQuery = trpc.institutions.getAll.useQuery(undefined, DEFAULT_QUERY_OPTIONS);
  const institutionTypesQuery = trpc.institutionTypes.getAll.useQuery(
    undefined,
    DEFAULT_QUERY_OPTIONS
  );
  const tokensQuery = trpc.tokens.getAll.useQuery(undefined, DEFAULT_QUERY_OPTIONS);
  const tokenTypesQuery = trpc.tokenTypes.getAll.useQuery(undefined, DEFAULT_QUERY_OPTIONS);

  const refreshAll = useCallback(async () => {
    await Promise.all([
      accountsQuery.refetch(),
      accountTypesQuery.refetch(),
      institutionsQuery.refetch(),
      institutionTypesQuery.refetch(),
      tokensQuery.refetch(),
      tokenTypesQuery.refetch(),
    ]);
  }, [
    accountsQuery,
    accountTypesQuery,
    institutionsQuery,
    institutionTypesQuery,
    tokensQuery,
    tokenTypesQuery,
  ]);

  const value = useMemo<EntityDataContextValue>(() => {
    const queries = [
      accountsQuery,
      accountTypesQuery,
      institutionsQuery,
      institutionTypesQuery,
      tokensQuery,
      tokenTypesQuery,
    ];

    const isReady = queries.every((query) => query.status === 'success');

    return {
      accounts: {
        data: accountsQuery.data ?? [],
        isLoading: accountsQuery.isLoading,
        isFetching: accountsQuery.isFetching,
        error: accountsQuery.error,
        refetch: () => accountsQuery.refetch(),
      },
      accountTypes: {
        data: accountTypesQuery.data ?? [],
        isLoading: accountTypesQuery.isLoading,
        isFetching: accountTypesQuery.isFetching,
        error: accountTypesQuery.error,
        refetch: () => accountTypesQuery.refetch(),
      },
      institutions: {
        data: institutionsQuery.data ?? [],
        isLoading: institutionsQuery.isLoading,
        isFetching: institutionsQuery.isFetching,
        error: institutionsQuery.error,
        refetch: () => institutionsQuery.refetch(),
      },
      institutionTypes: {
        data: institutionTypesQuery.data ?? [],
        isLoading: institutionTypesQuery.isLoading,
        isFetching: institutionTypesQuery.isFetching,
        error: institutionTypesQuery.error,
        refetch: () => institutionTypesQuery.refetch(),
      },
      tokens: {
        data: tokensQuery.data ?? [],
        isLoading: tokensQuery.isLoading,
        isFetching: tokensQuery.isFetching,
        error: tokensQuery.error,
        refetch: () => tokensQuery.refetch(),
      },
      tokenTypes: {
        data: tokenTypesQuery.data ?? [],
        isLoading: tokenTypesQuery.isLoading,
        isFetching: tokenTypesQuery.isFetching,
        error: tokenTypesQuery.error,
        refetch: () => tokenTypesQuery.refetch(),
      },
      isReady,
      refreshAll,
    };
  }, [
    accountsQuery,
    accountTypesQuery,
    institutionsQuery,
    institutionTypesQuery,
    tokensQuery,
    tokenTypesQuery,
    refreshAll,
  ]);

  return <EntityDataContext.Provider value={value}>{children}</EntityDataContext.Provider>;
}

export function useEntityData() {
  const context = useContext(EntityDataContext);
  if (!context) {
    throw new Error('useEntityData must be used within an EntityDataProvider');
  }
  return context;
}
