import { createContext, type ReactNode, useContext } from 'react';
import { useSearchParams } from 'react-router-dom';

interface PageFiltersContextValue {
  // URL-based filters
  institutionId?: string;
  accountId?: string;
  tokenId?: string;

  // Search and filter state
  searchTerm: string;
  setSearchTerm: (term: string) => void;

  filterBy: string;
  setFilterBy: (filter: string) => void;

  // Navigation helpers
  navigateToInstitution: (institutionId: string) => void;
  navigateToAccount: (institutionId: string, accountId: string) => void;
  navigateToHolding: (institutionId: string, accountId: string, holdingId: string) => void;
}

const PageFiltersContext = createContext<PageFiltersContextValue | undefined>(undefined);

interface PageFiltersProviderProps {
  children: ReactNode;
}

export function PageFiltersProvider({ children }: PageFiltersProviderProps) {
  const [searchParams, setSearchParams] = useSearchParams();

  // Extract URL parameters
  const institutionId = searchParams.get('institution') || undefined;
  const accountId = searchParams.get('account') || undefined;
  const tokenId = searchParams.get('token') || undefined;

  // Extract search and filter state
  const searchTerm = searchParams.get('search') || '';
  const filterBy = searchParams.get('filter') || 'all';

  const setSearchTerm = (term: string) => {
    const newParams = new URLSearchParams(searchParams);
    if (term) {
      newParams.set('search', term);
    } else {
      newParams.delete('search');
    }
    setSearchParams(newParams);
  };

  const setFilterBy = (filter: string) => {
    const newParams = new URLSearchParams(searchParams);
    if (filter && filter !== 'all') {
      newParams.set('filter', filter);
    } else {
      newParams.delete('filter');
    }
    setSearchParams(newParams);
  };

  // Navigation helpers
  const navigateToInstitution = (instId: string) => {
    window.location.href = `/institutions/${instId}`;
  };

  const navigateToAccount = (instId: string, accId: string) => {
    window.location.href = `/institutions/${instId}/accounts/${accId}`;
  };

  const navigateToHolding = (instId: string, accId: string, holdingId: string) => {
    window.location.href = `/institutions/${instId}/accounts/${accId}/holdings/${holdingId}`;
  };

  const value: PageFiltersContextValue = {
    institutionId,
    accountId,
    tokenId,
    searchTerm,
    setSearchTerm,
    filterBy,
    setFilterBy,
    navigateToInstitution,
    navigateToAccount,
    navigateToHolding,
  };

  return <PageFiltersContext.Provider value={value}>{children}</PageFiltersContext.Provider>;
}

export function usePageFilters() {
  const context = useContext(PageFiltersContext);
  if (context === undefined) {
    throw new Error('usePageFilters must be used within a PageFiltersProvider');
  }
  return context;
}
