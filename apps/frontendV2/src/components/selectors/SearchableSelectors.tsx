import { Coins, CreditCard, Plus } from "lucide-react";
import { Combobox } from "@/components/ui/combobox";
import {
  getAccountTypeIcon,
  getFaviconUrl,
  getInstitutionTypeIcon,
  getTokenTypeIcon,
} from "@/lib/icons";

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
    type?: string; // Type to show on the right
  }>;
  emptyMessage?: string;
  newItemLabel?: string;
  newItemValue?: string;
  id?: string;
  className?: string;
  isActive?: boolean; // Whether the filter has a non-default value
  popoverWidth?: string;
  compact?: boolean;
  buttonSize?: "default" | "sm";
  displayLabel?: string;
  disabled?: boolean;
}

export function SearchableSelect({
  value,
  onValueChange,
  placeholder,
  items,
  emptyMessage = "No items found",
  newItemLabel,
  newItemValue,
  id,
  className,
  isActive = false,
  popoverWidth,
  compact = false,
  buttonSize = "default",
  displayLabel,
  disabled = false,
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
          isActive ? "border-black border-2" : "border border-input"
        } ${className || ""}`}
        popoverWidth={popoverWidth}
        compact={compact}
        buttonSize={buttonSize}
        displayLabel={displayLabel}
        disabled={disabled}
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
  placeholder = "Choose token type...",
}: TokenTypeSelectorProps) {
  const tokenTypeOptions =
    tokenTypes?.map((type) => ({
      value: type.code,
      label: type.name,
      icon: getTokenTypeIcon(type.code),
      subtitle: type.description || undefined,
    })) || [];

  const isActive = value !== "" && value !== "all";
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
  placeholder = "Filter by account...",
  includeAllOption = false,
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
        icon: CreditCard,
        subtitle,
      };
    }) || [];

  const allOptions = includeAllOption
    ? [
        {
          value: "all",
          label: "All Accounts",
          icon: CreditCard,
        },
        ...accountOptions,
      ]
    : accountOptions;

  return (
    <SearchableSelect
      value={value}
      onValueChange={onValueChange}
      placeholder={placeholder}
      items={allOptions}
      emptyMessage="No accounts found."
      isActive={value !== ""}
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
    typeName?: string;
    iconUrl?: string | null;
  }>;
  placeholder?: string;
  includeAllOption?: boolean;
}

export function TokenFilterSelector({
  value,
  onValueChange,
  tokens,
  placeholder = "Filter by token...",
  includeAllOption = false,
}: TokenFilterSelectorProps) {
  const tokenOptions =
    tokens?.map((token) => ({
      value: token.id,
      label: token.symbol,
      icon: token.iconUrl
        ? () => (
            <img
              src={token.iconUrl!}
              alt={token.symbol}
              className="w-4 h-4 rounded-full"
            />
          )
        : getTokenTypeIcon(token.type || "unknown"),
      subtitle: token.name,
    })) || [];

  const allOptions = includeAllOption
    ? [{ value: "all", label: "All Tokens", icon: Coins }, ...tokenOptions]
    : tokenOptions;

  const isActive = value !== "";
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

// Account Type Selector Component
interface AccountTypeSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  accountTypes?: Array<{
    id: string;
    name: string;
    code: string;
    description?: string | null;
  }>;
  placeholder?: string;
  allowCreate?: boolean;
  onCreateNew?: (name: string) => void;
}

export function AccountTypeSelector({
  value,
  onValueChange,
  accountTypes,
  placeholder = "Choose account type...",
  allowCreate = true,
  onCreateNew,
}: AccountTypeSelectorProps) {
  const accountTypeOptions =
    accountTypes?.map((type) => ({
      value: type.id,
      label: type.name,
      icon: getAccountTypeIcon(type.code),
      subtitle: type.description || undefined,
    })) || [];

  const handleValueChange = (newValue: string) => {
    if (newValue === "__create_new__" && onCreateNew) {
      // Prompt user for new account type name
      const name = prompt("Enter the name for the new account type:");
      if (name?.trim()) {
        onCreateNew(name.trim());
      }
    } else {
      onValueChange(newValue);
    }
  };

  return (
    <SearchableSelect
      value={value}
      onValueChange={handleValueChange}
      placeholder={placeholder}
      items={accountTypeOptions}
      emptyMessage="No account types found."
      newItemLabel={allowCreate ? "Create new account type" : undefined}
      newItemValue={allowCreate ? "__create_new__" : undefined}
    />
  );
}

// Institution Selector Component
interface InstitutionSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  institutions?: Array<{
    id: string;
    name: string;
    typeName?: string;
    typeCode?: string;
    website?: string | null;
  }>;
  placeholder?: string;
  allowCreate?: boolean;
  onCreateNew?: (name: string) => void;
}

export function InstitutionSelector({
  value,
  onValueChange,
  institutions,
  placeholder = "Choose institution...",
  allowCreate = true,
  onCreateNew,
}: InstitutionSelectorProps) {
  const institutionOptions =
    institutions?.map((inst) => {
      const faviconUrl = getFaviconUrl(inst.website);

      return {
        value: inst.id,
        label: inst.name,
        icon: faviconUrl
          ? () => (
              <img
                src={faviconUrl}
                alt={inst.name}
                className="w-4 h-4 rounded-sm"
              />
            )
          : getInstitutionTypeIcon(inst.typeCode || "other"),
        subtitle: inst.typeName || undefined,
        isInstitution: true,
      };
    }) || [];

  const handleValueChange = (newValue: string) => {
    if (newValue === "__create_new__" && onCreateNew) {
      // Prompt user for new institution name
      const name = prompt("Enter the name for the new institution:");
      if (name?.trim()) {
        onCreateNew(name.trim());
      }
    } else {
      onValueChange(newValue);
    }
  };

  return (
    <SearchableSelect
      value={value}
      onValueChange={handleValueChange}
      placeholder={placeholder}
      items={institutionOptions}
      emptyMessage="No institutions found."
      newItemLabel={allowCreate ? "Create new institution" : undefined}
      newItemValue={allowCreate ? "__create_new__" : undefined}
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
  allowCreate?: boolean;
  onCreateNew?: (name: string) => void;
  disabled?: boolean;
}

export function InstitutionTypeSelector({
  value,
  onValueChange,
  institutionTypes,
  placeholder = "Choose institution type...",
  allowCreate = true,
  onCreateNew,
  disabled = false,
}: InstitutionTypeSelectorProps) {
  const institutionTypeOptions =
    institutionTypes?.map((type) => ({
      value: type.id,
      label: type.name,
      icon: getInstitutionTypeIcon(type.code),
      subtitle: type.description || undefined,
    })) || [];

  const handleValueChange = (newValue: string) => {
    if (newValue === "__create_new__" && onCreateNew) {
      // Prompt user for new institution type name
      const name = prompt("Enter the name for the new institution type:");
      if (name?.trim()) {
        onCreateNew(name.trim());
      }
    } else {
      onValueChange(newValue);
    }
  };

  return (
    <SearchableSelect
      value={value}
      onValueChange={handleValueChange}
      placeholder={placeholder}
      items={institutionTypeOptions}
      emptyMessage="No institution types found."
      newItemLabel={allowCreate ? "Create new institution type" : undefined}
      newItemValue={allowCreate ? "__create_new__" : undefined}
      disabled={disabled}
    />
  );
}
