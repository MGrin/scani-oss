import { Plus } from 'lucide-react';
import { Combobox } from '@/components/ui/combobox';
import { getTokenTypeIcon } from '@/lib/icons';

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

// Account Filter Selector (for filtering entities by account)
interface AccountFilterSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  accounts?: Array<{
    id: string;
    name: string;
    typeName?: string;
    institutionId: string;
  }>;
  institutions?: Array<{
    id: string;
    name: string;
  }>;
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

// Token Filter Selector (for filtering entities by token)
interface TokenFilterSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  tokens?: Array<{
    id: string;
    symbol: string;
    name: string;
    type?: string;
  }>;
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
      icon: getTokenTypeIcon(token.type || 'unknown'),
      subtitle: token.type || undefined,
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
