# Selector UI Enhancements - October 15, 2025

## Overview

Enhanced the selector components across Holdings and AddData pages to provide richer data display with proper icons, institution information, and improved token display formatting.

## Changes Made

### 1. Backend Updates

#### GetHoldingsWithDetailsUseCase

**File**: `apps/backend/src/application/use-cases/GetHoldingsWithDetailsUseCase.ts`

**Changes**:

- Enhanced `HoldingWithDetails` interface to include additional fields:
  - `token.iconUrl`: Token icon URL for display
  - `account.typeCode`: Account type code for icon mapping
  - `account.institutionId`: Institution ID for proper linking
  - `institution.typeCode`: Institution type code for icon mapping
  - `institution.website`: Institution website for favicon generation

**Impact**: Holdings data now includes all necessary fields for rich UI display in selectors.

---

### 2. Frontend Component Updates

#### AccountFilterSelector

**File**: `apps/frontendV2/src/components/selectors/SearchableSelectors.tsx`

**Changes**:

- Removed `type` field from display (was showing "Account" on every row)
- Enhanced to show institution name in subtitle
- Uses institution lookup to properly display "Institution • Account Type"

**Before**:

```tsx
{
  value: account.id,
  label: account.name,
  icon: CreditCard,
  subtitle,
  type: account.typeName || "Account", // ❌ Removed
}
```

**After**:

```tsx
{
  value: account.id,
  label: account.name,
  icon: CreditCard,
  subtitle: `${institution.name} • ${account.typeName}`, // ✅ Shows institution
}
```

---

#### TokenFilterSelector

**File**: `apps/frontendV2/src/components/selectors/SearchableSelectors.tsx`

**Changes**:

- Restructured to show **Token Symbol** on first line, **Token Name** on subtitle
- Added support for token icon URLs (falls back to type icon)
- Removed type display on the right

**Before**:

```tsx
label: `${token.symbol} - ${token.name}`, // ❌ Combined on one line
icon: Coins,
subtitle: token.typeName,
type: token.typeName || "Token", // ❌ Type on right
```

**After**:

```tsx
label: token.symbol, // ✅ Symbol on first line
icon: token.iconUrl
  ? () => <img src={token.iconUrl} className="w-4 h-4 rounded-full" />
  : getTokenTypeIcon(token.type), // ✅ Icon or type icon
subtitle: token.name, // ✅ Name on second line
```

---

#### AccountTypeSelector

**File**: `apps/frontendV2/src/components/selectors/SearchableSelectors.tsx`

**Changes**:

- Removed `type: "Account Type"` from options to avoid redundant display

**Before**:

```tsx
{
  value: type.id,
  label: type.name,
  icon: CreditCard,
  subtitle: type.description,
  type: "Account Type", // ❌ Removed
}
```

**After**:

```tsx
{
  value: type.id,
  label: type.name,
  icon: CreditCard,
  subtitle: type.description, // ✅ Clean display
}
```

---

#### InstitutionSelector

**File**: `apps/frontendV2/src/components/selectors/SearchableSelectors.tsx`

**Changes**:

- Added favicon support using `getFaviconUrl()` utility
- Falls back to institution type icon if no website/favicon
- Removed `type` field from display
- Enhanced interface to accept `typeCode` and `website` fields

**Before**:

```tsx
{
  value: inst.id,
  label: inst.name,
  icon: Building2, // ❌ Generic icon
  subtitle: inst.typeName,
  type: inst.typeName || "Institution", // ❌ Removed
}
```

**After**:

```tsx
{
  value: inst.id,
  label: inst.name,
  icon: faviconUrl
    ? () => <img src={faviconUrl} className="w-4 h-4 rounded-sm" />
    : getInstitutionTypeIcon(inst.typeCode), // ✅ Favicon or type icon
  subtitle: inst.typeName, // ✅ Clean display
}
```

---

#### InstitutionTypeSelector

**File**: `apps/frontendV2/src/components/selectors/SearchableSelectors.tsx`

**Changes**:

- Added `code` field to interface for proper icon mapping
- Updated to use `getInstitutionTypeIcon()` for different icons per type
- Removed `type: "Institution Type"` from display

**Before**:

```tsx
{
  value: type.id,
  label: type.name,
  icon: Building2, // ❌ Same icon for all
  subtitle: type.description,
  type: "Institution Type", // ❌ Removed
}
```

**After**:

```tsx
{
  value: type.id,
  label: type.name,
  icon: getInstitutionTypeIcon(type.code), // ✅ Different icons per type
  subtitle: type.description, // ✅ Clean display
}
```

---

### 3. Utility Functions

#### getFaviconUrl

**File**: `apps/frontendV2/src/lib/icons.ts`

**New Function**:

```tsx
/**
 * Get favicon URL from a website URL
 * Uses Google's favicon service as a fallback
 */
export function getFaviconUrl(
  websiteUrl: string | null | undefined
): string | null {
  if (!websiteUrl) return null;

  try {
    const url = new URL(
      websiteUrl.startsWith("http") ? websiteUrl : `https://${websiteUrl}`
    );
    return `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=64`;
  } catch {
    return null;
  }
}
```

**Purpose**: Generates favicon URLs for institutions using Google's favicon service, providing visual identification for financial institutions.

---

### 4. Page Updates

#### Holdings.tsx

**File**: `apps/frontendV2/src/pages/Holdings.tsx`

**Changes**:

- Updated `accountOptions` to use actual `institutionId` instead of "dummy" value
- Enhanced `institutionOptions` to include `typeCode` and `website`
- Enhanced `tokenOptions` to include `typeName` and `iconUrl`

**Data Mapping**:

```tsx
// Accounts - now includes institutionId
const accountOptions = accounts.map((acc) => ({
  id: acc.id,
  name: acc.name,
  typeName: acc.type,
  institutionId: acc.institutionId, // ✅ Real institution ID
}));

// Institutions - now includes type and website
const institutionOptions = institutions.map((inst) => ({
  id: inst.id,
  name: inst.name,
  type: inst.type,
  typeCode: inst.typeCode, // ✅ For icon mapping
  website: inst.website, // ✅ For favicon
}));

// Tokens - enhanced with type name and icon
const tokenOptions = Array.from(tokenMap.values()).map((token) => ({
  id: token.symbol,
  symbol: token.symbol,
  name: token.name,
  type: token.typeCode,
  typeName: token.type, // ✅ Type display name
  iconUrl: token.iconUrl, // ✅ Token icon
}));
```

---

## Icon Mapping

### Institution Types

Using `getInstitutionTypeIcon(typeCode)`:

| Type Code         | Icon       | Description              |
| ----------------- | ---------- | ------------------------ |
| `bank`            | Building   | Traditional banks        |
| `brokerage`       | TrendingUp | Investment brokerages    |
| `crypto-exchange` | Coins      | Cryptocurrency exchanges |
| `real-estate`     | Home       | Real estate holdings     |
| `other`           | Building2  | Default/Other types      |

### Account Types

Using `getAccountTypeIcon(typeCode)`:

| Type Code     | Icon       | Description          |
| ------------- | ---------- | -------------------- |
| `checking`    | Wallet     | Checking accounts    |
| `savings`     | PiggyBank  | Savings accounts     |
| `investment`  | TrendingUp | Investment accounts  |
| `crypto`      | Coins      | Crypto accounts      |
| `real estate` | Home       | Real estate accounts |
| `other`       | CreditCard | Default account type |

### Token Types

Using `getTokenTypeIcon(typeCode)`:

- Token-specific icons when `token.iconUrl` is available
- Falls back to type-based icons for generic display

---

## User Experience Improvements

### Holdings Page

1. **Account Filter**: Now shows institution name alongside account type
   - Example: "Primary Checking" with subtitle "Chase Bank • Checking"
2. **Token Filter**: Cleaner display with symbol emphasized
   - Example: "BTC" as label, "Bitcoin" as subtitle, with Bitcoin icon
3. **Better Visual Identification**:
   - Token icons for crypto/stocks
   - Account type icons for quick recognition

### AddData Page

1. **Account Type Selection**: Cleaner display without redundant "Account Type" text
2. **Institution Selection**:

   - Shows actual institution favicons (e.g., Chase logo, Fidelity logo)
   - Falls back to type icons when favicon unavailable
   - Cleaner display without redundant type text

3. **Institution Type Selection**:
   - Different icons per type (Bank icon for banks, TrendingUp for brokerages)
   - Cleaner display without redundant "Institution Type" text

---

## Technical Notes

### Type Safety

- All changes maintain full TypeScript type safety
- Enhanced interfaces to include new optional fields
- Proper fallbacks for missing data

### Performance

- Favicon URLs generated on-demand
- No additional API calls (uses existing data)
- Efficient mapping and deduplication

### Backwards Compatibility

- All new fields are optional
- Graceful fallbacks when data is missing
- No breaking changes to existing functionality

---

## Testing Checklist

- [x] Backend type-check passes
- [x] Frontend type-check passes
- [ ] Holdings page account filter shows institution names
- [ ] Holdings page token filter shows symbol/name correctly
- [ ] AddData page account type selector has no redundant type text
- [ ] AddData page institution selector shows favicons
- [ ] AddData page institution type selector has different icons
- [ ] All selectors display properly on mobile
- [ ] Favicon fallbacks work when website is missing
- [ ] Icon fallbacks work when iconUrl is missing

---

## Future Enhancements

1. **Cache Favicons**: Consider caching favicon URLs to reduce external requests
2. **Custom Icons**: Allow users to upload custom institution logos
3. **Icon Service**: Consider self-hosting favicons instead of relying on Google
4. **Token Icons**: Integrate with token icon services (CoinGecko, CryptoCompare)
5. **Search by Icon**: Enable users to filter by visual appearance
