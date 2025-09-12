import { Plus } from 'lucide-react';
import { Combobox } from '@/components/ui/combobox';
import { TokenSymbol } from '@/components/ui/TokenSymbol';
import type { ApiAccount, ApiInstitution, ApiToken } from '@/lib/api-types';
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
        className={className}
      />
    </div>
  );
}

// Account Selector Component
interface AccountSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  accounts?: ApiAccount[];
  id?: string;
  placeholder?: string;
}

export function AccountSelector({
  value,
  onValueChange,
  accounts,
  id,
  placeholder = 'Choose an account...',
}: AccountSelectorProps) {
  const accountOptions =
    accounts?.map((account) => ({
      value: account.id,
      label: account.name,
      icon: getAccountTypeIcon(account.type || 'unknown'),
      subtitle: account.typeName || undefined,
    })) || [];

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

  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      items={tokenTypeOptions}
      emptyMessage="No token types found."
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

  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      items={accountTypeOptions}
      emptyMessage="No account types found."
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

  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      items={institutionTypeOptions}
      emptyMessage="No institution types found."
    />
  );
}
