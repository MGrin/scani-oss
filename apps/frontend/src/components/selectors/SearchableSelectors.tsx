import { Plus } from 'lucide-react';
import { TRANSACTION_TYPE_METADATA } from '@/components/TransactionForm';
import { Combobox } from '@/components/ui/combobox';
import { TokenSymbol } from '@/components/ui/TokenSymbol';
import type { ApiAccount, ApiHolding, ApiInstitution, ApiToken } from '@/lib/api-types';
import { getAccountTypeIcon, getTokenTypeIcon } from '@/lib/icons';

// Base Searchable Select Component using Combobox
interface SearchableSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  items: Array<{
    value: string;
    label: string;
    icon?: React.ComponentType<{ className?: string }>;
    subtitle?: string;
    description?: string;
    isInstitution?: boolean;
  }>;
  emptyMessage?: string;
  newItemLabel?: string;
  newItemValue?: string;
  id?: string;
  className?: string;
  isActive?: boolean; // Whether the filter has a non-default value
  popoverWidth?: string;
  compact?: boolean;
  buttonSize?: 'default' | 'sm';
  displayLabel?: string;
}

export function SearchableSelect({
  value,
  onValueChange,
  placeholder,
  items,
  emptyMessage = 'No items found',
  newItemLabel,
  newItemValue,
  id,
  className,
  isActive = false,
  popoverWidth,
  compact = false,
  buttonSize = 'default',
  displayLabel,
}: SearchableSelectProps) {
  // Add the "new item" option if provided
  const allItems =
    newItemLabel && newItemValue
      ? [
          {
            value: newItemValue,
            label: newItemLabel,
            icon: Plus,
          },
          ...items,
        ]
      : items;

  return (
    <div id={id} className="w-full">
      <Combobox
        value={value}
        onValueChange={onValueChange}
        placeholder={placeholder}
        emptyMessage={emptyMessage}
        items={allItems}
        onSearchChange={() => {
          /* debounced in Combobox; consumers can pass-through later */
        }}
        className={`w-full ${
          isActive ? 'border-black border-2' : 'border border-input'
        } ${className || ''}`}
        popoverWidth={popoverWidth}
        compact={compact}
        buttonSize={buttonSize}
        displayLabel={displayLabel}
      />
    </div>
  );
}

// Account Selector Component
interface AccountSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  accounts?: ApiAccount[];
  institutions?: ApiInstitution[];
  id?: string;
  placeholder?: string;
}

export function AccountSelector({
  value,
  onValueChange,
  accounts,
  institutions,
  id,
  placeholder = 'Choose an account...',
}: AccountSelectorProps) {
  // Create institutions map for quick lookups
  const institutionsMap = institutions
    ? Object.fromEntries(institutions.map((inst) => [inst.id, inst]))
    : {};

  const accountOptions =
    accounts?.map((account) => {
      const institution = institutionsMap[account.institutionId];

      // Build subtitle with institution name and account type
      const subtitleParts: string[] = [];
      if (institution?.name) {
        subtitleParts.push(institution.name);
      }
      if (account.typeName) {
        subtitleParts.push(account.typeName);
      }
      const subtitle = subtitleParts.length > 0 ? subtitleParts.join(' • ') : undefined;

      return {
        value: account.id,
        label: account.name,
        icon: getAccountTypeIcon(account.type || 'unknown'),
        subtitle,
      };
    }) || [];

  const isActive = value !== '' && value !== 'all' && value !== 'new';
  return (
    <SearchableSelect
      id={id}
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      items={accountOptions}
      emptyMessage={
        accounts?.length === 0
          ? 'No accounts found. Create a new one below.'
          : 'No accounts match your search.'
      }
      newItemLabel="Create New Account"
      newItemValue="new"
      isActive={isActive}
    />
  );
}

// Institution Selector Component
interface InstitutionSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  institutions?: ApiInstitution[];
  id?: string;
  placeholder?: string;
}

export function InstitutionSelector({
  value,
  onValueChange,
  institutions,
  id,
  placeholder = 'Choose an institution...',
}: InstitutionSelectorProps) {
  const institutionOptions =
    institutions?.map((institution) => {
      // Build the first line with type and website
      const firstLineParts: string[] = [];
      if (institution.typeName) {
        firstLineParts.push(institution.typeName);
      }
      if (institution.website) {
        firstLineParts.push(institution.website);
      }
      const firstLine = firstLineParts.length > 0 ? firstLineParts.join(' | ') : undefined;

      return {
        value: institution.id,
        label: institution.name,
        subtitle: firstLine,
        description: institution.description || undefined,
        isInstitution: true, // Flag to identify institution items for special rendering
      };
    }) || [];

  const isActive = value !== '' && value !== 'all' && value !== 'new';
  return (
    <SearchableSelect
      id={id}
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      items={institutionOptions}
      emptyMessage={
        institutions?.length === 0
          ? 'No institutions found. Create a new one below.'
          : 'No institutions match your search.'
      }
      newItemLabel="Create New Institution"
      newItemValue="new"
      isActive={isActive}
    />
  );
}

// Token Selector Component
interface TokenSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  tokens?: ApiToken[];
  id?: string;
  placeholder?: string;
}

export function TokenSelector({
  value,
  onValueChange,
  tokens,
  id,
  placeholder = 'Choose a token...',
}: TokenSelectorProps) {
  const tokenOptions =
    tokens?.map((token) => ({
      value: token.id,
      label: `${token.symbol} - ${token.name}`,
      icon: ({ className }: { className?: string }) => (
        <TokenSymbol type={token.type || 'unknown'} symbol={token.symbol} className={className} />
      ),
      subtitle: token.typeName || undefined,
    })) || [];

  return (
    <SearchableSelect
      id={id}
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      items={tokenOptions}
      emptyMessage="No tokens match your search."
      newItemLabel="Create New Token"
      newItemValue="new"
    />
  );
}

// Token Filter Selector (for filtering entities by token)
interface TokenFilterSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  tokens?: ApiToken[];
  placeholder?: string;
  includeAllOption?: boolean;
}

export function TokenFilterSelector({
  value,
  onValueChange,
  tokens,
  placeholder = 'Filter by token...',
  includeAllOption = true,
}: TokenFilterSelectorProps) {
  const tokenOptions =
    tokens?.map((token) => ({
      value: token.id,
      label: `${token.symbol} - ${token.name}`,
      icon: ({ className }: { className?: string }) => (
        <TokenSymbol type={token.type || 'unknown'} symbol={token.symbol} className={className} />
      ),
      subtitle: token.typeName || undefined,
    })) || [];

  const allOptions = includeAllOption
    ? [{ value: 'all', label: 'All Tokens' }, ...tokenOptions]
    : tokenOptions;

  const isActive = value !== '' && value !== 'all';
  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      items={allOptions}
      emptyMessage="No tokens found."
      isActive={isActive}
    />
  );
}

// Token Type Selector Component
interface TokenTypeSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  tokenTypes?: Array<{
    id: string;
    code: string;
    name: string;
    description?: string | null;
  }>;
  placeholder?: string;
}

export function TokenTypeSelector({
  value,
  onValueChange,
  tokenTypes,
  placeholder = 'Choose token type...',
}: TokenTypeSelectorProps) {
  const tokenTypeOptions =
    tokenTypes?.map((type) => ({
      value: type.code,
      label: type.name,
      icon: getTokenTypeIcon(type.code),
      subtitle: type.description || undefined,
    })) || [];

  const isActive = value !== '' && value !== 'all';
  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      items={tokenTypeOptions}
      emptyMessage="No token types found."
      isActive={isActive}
    />
  );
}

// Account Type Selector Component
interface AccountTypeSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  accountTypes?: Array<{
    id: string;
    code: string;
    name: string;
    description?: string | null;
  }>;
  placeholder?: string;
}

export function AccountTypeSelector({
  value,
  onValueChange,
  accountTypes,
  placeholder = 'Choose account type...',
}: AccountTypeSelectorProps) {
  const accountTypeOptions =
    accountTypes?.map((type) => ({
      value: type.code,
      label: type.name,
      icon: getAccountTypeIcon(type.code),
      subtitle: type.description || undefined,
    })) || [];

  const isActive = value !== '' && value !== 'all';
  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      items={accountTypeOptions}
      emptyMessage="No account types found."
      isActive={isActive}
    />
  );
}

// Institution Type Selector Component
interface InstitutionTypeSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  institutionTypes?: Array<{
    id: string;
    code: string;
    name: string;
    description?: string | null;
  }>;
  placeholder?: string;
}

export function InstitutionTypeSelector({
  value,
  onValueChange,
  institutionTypes,
  placeholder = 'Choose institution type...',
}: InstitutionTypeSelectorProps) {
  const institutionTypeOptions =
    institutionTypes?.map((type) => ({
      value: type.code,
      label: type.name,
      subtitle: type.description || undefined,
    })) || [];

  const isActive = value !== '' && value !== 'all';
  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      items={institutionTypeOptions}
      emptyMessage="No institution types found."
      isActive={isActive}
    />
  );
}

// Transaction Type Selector Component
interface TransactionTypeSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  transactionTypes?: Array<{
    id: string;
    code: string;
    name: string;
    description?: string | null;
  }>;
  placeholder?: string;
}

export function TransactionTypeSelector({
  value,
  onValueChange,
  transactionTypes,
  placeholder = 'Choose transaction type...',
}: TransactionTypeSelectorProps) {
  // Create icon component from emoji string
  const createEmojiIcon =
    (emoji: string) =>
    ({ className }: { className?: string }) => (
      <span className={`text-base ${className || ''}`}>{emoji}</span>
    );

  const transactionTypeOptions =
    transactionTypes?.map((type) => {
      const metadata = TRANSACTION_TYPE_METADATA[type.code];
      return {
        value: type.code,
        label: type.name,
        subtitle: type.description || undefined,
        icon: metadata?.icon ? createEmojiIcon(metadata.icon) : undefined,
      };
    }) || [];

  const isActive = value !== '' && value !== 'all';
  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      items={transactionTypeOptions}
      emptyMessage="No transaction types found."
      isActive={isActive}
    />
  );
}

// Institution Filter Selector (for filtering entities by institution)
interface InstitutionFilterSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  institutions?: ApiInstitution[];
  placeholder?: string;
  includeAllOption?: boolean;
}

export function InstitutionFilterSelector({
  value,
  onValueChange,
  institutions,
  placeholder = 'Filter by institution...',
  includeAllOption = true,
}: InstitutionFilterSelectorProps) {
  const institutionOptions =
    institutions?.map((institution) => ({
      value: institution.id,
      label: institution.name,
      subtitle: institution.typeName || undefined,
    })) || [];

  const allOptions = includeAllOption
    ? [{ value: 'all', label: 'All Institutions' }, ...institutionOptions]
    : institutionOptions;

  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      items={allOptions}
      emptyMessage="No institutions found."
      isActive={value !== 'all' && value !== ''}
    />
  );
}

// Account Filter Selector (for filtering entities by account)
interface AccountFilterSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  accounts?: ApiAccount[];
  institutions?: ApiInstitution[];
  placeholder?: string;
  includeAllOption?: boolean;
}

export function AccountFilterSelector({
  value,
  onValueChange,
  accounts,
  institutions,
  placeholder = 'Filter by account...',
  includeAllOption = true,
}: AccountFilterSelectorProps) {
  // Create institution lookup map
  const institutionsMap = institutions
    ? Object.fromEntries(institutions.map((inst) => [inst.id, inst]))
    : {};

  const accountOptions =
    accounts?.map((account) => {
      const institution = institutionsMap[account.institutionId];
      const subtitle =
        institution?.name && account.typeName
          ? `${institution.name} • ${account.typeName}`
          : account.typeName || institution?.name || undefined;

      return {
        value: account.id,
        label: account.name,
        subtitle,
      };
    }) || [];

  const allOptions = includeAllOption
    ? [{ value: 'all', label: 'All Accounts' }, ...accountOptions]
    : accountOptions;

  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      items={allOptions}
      emptyMessage="No accounts found."
      isActive={value !== 'all' && value !== ''}
    />
  );
}

// Holding Filter Selector (for filtering entities by holding)
interface HoldingFilterSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  holdings?: ApiHolding[];
  tokens?: ApiToken[];
  accounts?: ApiAccount[];
  placeholder?: string;
  includeAllOption?: boolean;
}

export function HoldingFilterSelector({
  value,
  onValueChange,
  holdings,
  tokens,
  accounts,
  placeholder = 'Filter by holding...',
  includeAllOption = true,
}: HoldingFilterSelectorProps) {
  const tokensMap = tokens ? Object.fromEntries(tokens.map((t) => [t.id, t])) : {};
  const accountsMap = accounts ? Object.fromEntries(accounts.map((a) => [a.id, a])) : {};

  const holdingOptions =
    holdings?.map((holding) => {
      const token = tokensMap[holding.tokenId];
      const account = accountsMap[holding.accountId];
      return {
        value: holding.id,
        label: token
          ? `${token.symbol} in ${account?.name || 'Unknown Account'}`
          : `Unknown Token in ${account?.name || 'Unknown Account'}`,
        subtitle: token ? `${token.name} - ${holding.balance || 'N/A'} units` : undefined,
        icon: token
          ? ({ className }: { className?: string }) => (
              <TokenSymbol
                type={token.type || 'unknown'}
                symbol={token.symbol}
                className={className}
              />
            )
          : undefined,
      };
    }) || [];

  const allOptions = includeAllOption
    ? [{ value: 'all', label: 'All Holdings' }, ...holdingOptions]
    : holdingOptions;

  const isActive = value !== '' && value !== 'all';
  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      items={allOptions}
      emptyMessage="No holdings found."
      isActive={isActive}
    />
  );
}

// Currency Selector Component
interface CurrencySelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  currencies?: Array<{
    id: string;
    symbol: string;
    name: string;
  }>;
  id?: string;
  placeholder?: string;
  popoverWidth?: string;
  compact?: boolean;
  buttonSize?: 'default' | 'sm';
  className?: string;
}

export function CurrencySelector({
  value,
  onValueChange,
  currencies,
  id,
  placeholder = 'Select currency...',
  popoverWidth,
  compact = false,
  buttonSize = 'default',
  className,
}: CurrencySelectorProps) {
  const currencyOptions =
    currencies?.map((currency) => ({
      value: currency.id,
      label: `${currency.symbol} - ${currency.name}`,
      subtitle: currency.name,
    })) || [];

  // Find selected currency to display only its symbol in compact mode
  const selectedCurrency = currencies?.find((c) => c.id === value);
  const displayLabel = compact && selectedCurrency ? selectedCurrency.symbol : undefined;

  return (
    <SearchableSelect
      id={id}
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      items={currencyOptions}
      emptyMessage="No currencies match your search."
      popoverWidth={popoverWidth}
      compact={compact}
      buttonSize={buttonSize}
      displayLabel={displayLabel}
      className={className}
    />
  );
}
