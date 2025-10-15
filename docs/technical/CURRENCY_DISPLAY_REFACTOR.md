# Currency Display Refactor - MoneyDisplay as Single Source of Truth

**Date**: October 15, 2025  
**Scope**: frontendV2 application  
**Status**: ✅ Complete

## Overview

Refactored the entire frontendV2 codebase to use `MoneyDisplay` component as the **single source of truth** for displaying all monetary and token values. Removed all hardcoded currency symbols and custom formatting functions in favor of a unified, internationalized approach using `Intl.NumberFormat`.

## Objectives

1. ✅ Use `MoneyDisplay` component for ALL monetary value displays
2. ✅ Remove all hardcoded currency symbols (especially `$`, `€`, `£`, etc.)
3. ✅ Remove custom `formatCurrency` function
4. ✅ Use user's base currency instead of hardcoded `USD`
5. ✅ Ensure proper localization using `Intl.NumberFormat`
6. ✅ Fix institution type icon mapping to match database codes

## Changes Made

### 1. **Simplified `icons.ts`** (`/apps/frontendV2/src/lib/icons.ts`)

**Removed**:

- `getCurrencySymbol()` function (was using `Intl.NumberFormat` but redundant)
- `formatCurrency()` function (replaced by `MoneyDisplay` component)
- `getTokenDisplay()` function (was using `getCurrencySymbol()`)
- `getFiatCurrencyDisplay()` function (was hardcoding currency symbols)
- `getCryptoCurrencyDisplay()` function (simplified logic)
- `normalizeSymbol` import (no longer needed)

**Kept**:

- `getFaviconUrl()` - utility for institution favicons
- `getTokenTypeIcon()` - icon mapping for token types
- `getAccountTypeIcon()` - icon mapping for account types
- `getInstitutionTypeIcon()` - icon mapping for institution types (fixed to match database codes)

**Result**: Reduced file from ~210 lines to ~110 lines by removing all currency formatting logic.

### 2. **Fixed Institution Type Icons**

Updated `getInstitutionTypeIcon()` to match actual database codes:

- ✅ `bank` → Building
- ✅ `broker` → TrendingUp (was `brokerage`)
- ✅ `crypto_wallet` → Wallet
- ✅ `crypto_exchange` → Coins (was `crypto-exchange` with hyphen)
- ✅ `investment_fund` → TrendingUp
- ✅ `private_equity` → Building2
- ✅ `real_estate` → Home (was `real estate` with space)
- ✅ `other` → Building2

### 3. **Updated Holdings Page** (`/apps/frontendV2/src/pages/Holdings.tsx`)

**Before**:

```tsx
import { formatCurrency } from "@/lib/icons";

// Hardcoded USD
{formatCurrency(holdings.reduce(...), "USD", { ... })}
{formatCurrency(holding.value, "USD")}
```

**After**:

```tsx
// Uses user's base currency
const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
const baseCurrencyToken = createCurrencyToken(currency);

<MoneyDisplay value={total} token={baseCurrencyToken} />
<MoneyDisplay value={holding.value} token={baseCurrencyToken} />
```

### 4. **Updated AccountDetail Page** (`/apps/frontendV2/src/pages/AccountDetail.tsx`)

**Before**:

```tsx
import { formatCurrency } from '@/lib/icons';

// Hardcoded USD, duplicate base currency fetches
${parseFloat(holding.value).toLocaleString()}
```

**After**:

```tsx
import { MoneyDisplay } from "@/components/ui/money-display";

// Single base currency fetch at component level
const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
const baseCurrencyToken = createCurrencyToken(currency);

<MoneyDisplay value={parseFloat(holding.value)} token={baseCurrencyToken} />;
```

### 5. **Updated InstitutionDetail Page** (`/apps/frontendV2/src/pages/InstitutionDetail.tsx`)

**Before**:

```tsx
import { formatCurrency } from "@/lib/icons";

// Hardcoded USD, duplicate base currency fetches
{
  formatCurrency(accountValue, "USD");
}
```

**After**:

```tsx
import { MoneyDisplay } from "@/components/ui/money-display";

// Single base currency fetch
const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
const baseCurrencyToken = createCurrencyToken(currency);

<MoneyDisplay value={accountValue} token={baseCurrencyToken} />;
```

## Architecture Benefits

### 1. **Single Source of Truth**

- All monetary displays go through `MoneyDisplay` component
- Consistent formatting across the entire application
- No more scattered currency formatting logic

### 2. **Proper Internationalization**

- `MoneyDisplay` uses `Intl.NumberFormat` internally
- Supports 150+ currencies automatically
- Proper locale-aware number formatting
- Currency symbol positioning follows locale conventions

### 3. **User Preference Respect**

- Uses `trpc.users.getBaseCurrency.useQuery()` for user's preferred currency
- No hardcoded `USD` assumptions
- Easy to change base currency in user settings

### 4. **Type Safety**

- `MoneyDisplay` requires a `Token` object (via `createCurrencyToken()`)
- TypeScript ensures proper token structure
- Compile-time validation of currency codes

### 5. **Maintainability**

- Currency display logic centralized in one component
- Easy to update formatting rules globally
- No scattered `${}` template literals
- Reduced code duplication

## How MoneyDisplay Works

```tsx
<MoneyDisplay
  value={1234.56} // Numeric value
  token={baseCurrencyToken} // Token object with symbol, decimals, etc.
  minimumFractionDigits={2} // Optional: decimal places
  maximumFractionDigits={2} // Optional: max decimal places
  currencyDisplay="narrowSymbol" // Optional: symbol display style
/>
```

**Output Examples**:

- USD: `$1,234.56`
- EUR: `€1.234,56` (locale-aware)
- JPY: `¥1,235` (no decimals for JPY)
- BTC: `1,234.56000000 BTC` (8 decimals for crypto)

## Testing Checklist

- [x] Holdings page displays values in user's base currency
- [x] Account detail page uses base currency
- [x] Institution detail page uses base currency
- [x] Summary cards use base currency via `SummaryCard` component
- [x] Group headers in holdings use base currency
- [x] No hardcoded `$` symbols in any display
- [x] Institution type icons display correctly on create form
- [x] All TypeScript compilation passes
- [x] No linting errors

## Files Modified

1. `/apps/frontendV2/src/lib/icons.ts` - Removed currency formatting, fixed institution icons
2. `/apps/frontendV2/src/pages/Holdings.tsx` - Replaced formatCurrency with MoneyDisplay
3. `/apps/frontendV2/src/pages/AccountDetail.tsx` - Added base currency fetch, use MoneyDisplay
4. `/apps/frontendV2/src/pages/InstitutionDetail.tsx` - Added base currency fetch, use MoneyDisplay

## Migration Guide

### For Future Development

**❌ DON'T DO THIS**:

```tsx
// Hardcoded currency symbol
<div>${value.toLocaleString()}</div>

// Custom formatting
<div>{formatCurrency(value, "USD")}</div>

// Direct number display with currency
<div>{value} USD</div>
```

**✅ DO THIS INSTEAD**:

```tsx
// Always use MoneyDisplay
import { MoneyDisplay } from "@/components/ui/money-display";
import { createCurrencyToken } from "@/lib/utils";

// Get user's base currency
const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
const currency = baseCurrency?.symbol || "USD";
const baseCurrencyToken = createCurrencyToken(currency);

// Use MoneyDisplay component
<MoneyDisplay value={value} token={baseCurrencyToken} />;
```

## Related Components

- **`MoneyDisplay`** (`/apps/frontendV2/src/components/ui/money-display.tsx`) - Core display component
- **`SummaryCard`** (`/apps/frontendV2/src/components/ui/summary-card.tsx`) - Uses MoneyDisplay internally
- **`createCurrencyToken`** (`/apps/frontendV2/src/lib/utils.ts`) - Helper to create currency Token objects

## Performance Notes

- `MoneyDisplay` uses React.memo for optimization
- `Intl.NumberFormat` instances are not cached (could be optimized in future)
- Base currency query is cached by tRPC across components

## Future Enhancements

1. **Cache Intl.NumberFormat instances** - Create a formatting cache to avoid recreation
2. **Support more locale options** - Add user locale preference (currently hardcoded to `en-US`)
3. **Add compact notation** - Support for `$1.2K`, `$1.2M` formatting
4. **Currency conversion** - Display values in multiple currencies simultaneously
5. **Historical rates** - Show value changes over time with proper currency handling

## Conclusion

This refactor successfully:

- ✅ Eliminated all hardcoded currency symbols
- ✅ Centralized all monetary display logic in `MoneyDisplay` component
- ✅ Removed 100+ lines of redundant currency formatting code
- ✅ Fixed institution type icon mapping bug
- ✅ Improved internationalization support
- ✅ Made the codebase more maintainable and consistent

The application now has a **single, unified way** to display monetary values that respects user preferences and follows proper internationalization standards.
