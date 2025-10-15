# Account Details Page Sorting Enhancement

**Date**: October 15, 2025  
**Status**: ✅ Completed

## Overview

Enhanced the Account Details page DataTable to make all columns sortable, providing users with better control over how they view their account holdings.

## Changes Made

### 1. Added Sorting State Management

**File**: `apps/frontendV2/src/pages/AccountDetail.tsx`

```typescript
// Added sorting state
const [sortField, setSortField] = useState("value");
const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
```

- **Default Sort**: By "value" in descending order (highest value first)
- **State Management**: React useState hooks for sort field and direction

### 2. Implemented Sorting Logic

**Added `sortedHoldings` computed value:**

```typescript
const sortedHoldings = useMemo(() => {
  if (!accountHoldings) return [];

  return [...accountHoldings].sort((a, b) => {
    let aValue: any, bValue: any;

    switch (sortField) {
      case "token":
        aValue = a.token.name.toLowerCase();
        bValue = b.token.name.toLowerCase();
        break;
      case "amount":
        aValue = parseFloat(a.amount);
        bValue = parseFloat(b.amount);
        break;
      case "price":
        aValue = a.price ? parseFloat(a.price.value) : 0;
        bValue = b.price ? parseFloat(b.price.value) : 0;
        break;
      case "value":
      default:
        aValue = parseFloat(a.value);
        bValue = parseFloat(b.value);
        break;
    }

    if (typeof aValue === "string") {
      return sortDirection === "asc"
        ? aValue.localeCompare(bValue)
        : bValue.localeCompare(aValue);
    }

    return sortDirection === "asc" ? aValue - bValue : bValue - aValue;
  });
}, [accountHoldings, sortField, sortDirection]);
```

**Sorting Fields:**

- **Token**: Alphabetical by token name (case-insensitive)
- **Amount**: Numeric by holding amount
- **Price**: Numeric by current price (0 for missing prices)
- **Value**: Numeric by total value (default)

### 3. Added Sort Handler

```typescript
const handleSort = (field: string) => {
  if (sortField === field) {
    setSortDirection(sortDirection === "asc" ? "desc" : "asc");
  } else {
    setSortField(field);
    setSortDirection("desc");
  }
};
```

**Behavior:**

- Click same column: Toggle between ascending/descending
- Click different column: Switch to new column, start with descending

### 4. Updated DataTable Configuration

**Made all columns sortable:**

```typescript
columns={[
  {
    header: "Token",
    accessor: (row: HoldingWithDetails) => (...),
    sortable: true,  // ✅ Added
  },
  {
    header: "Amount",
    accessor: (row: HoldingWithDetails) => (...),
    className: "font-mono",
    sortable: true,  // ✅ Added
  },
  {
    header: "Price",
    accessor: (row: HoldingWithDetails) => (...),
    className: "font-mono",
    sortable: true,  // ✅ Added
  },
  {
    header: "Value",
    accessor: (row: HoldingWithDetails) => (...),
    className: "font-mono font-medium",
    sortable: true,  // ✅ Added
  },
]}
```

**Added sorting props to DataTable:**

```typescript
<DataTable
  data={sortedHoldings || []} // ✅ Use sorted data
  // ... columns config
  onSort={handleSort} // ✅ Sort handler
  sortField={sortField} // ✅ Current sort field
  sortDirection={sortDirection} // ✅ Current sort direction
/>
```

### 5. Updated Summary Cards

**Total Value and Holdings Count:**

- Now use `sortedHoldings` instead of `accountHoldings`
- Ensures summary cards reflect the sorted data

## User Experience Improvements

### Visual Indicators

- **Sort Icons**: ArrowUpDown icons appear on sortable column headers
- **Hover Effects**: Column headers show hover states for sortable columns
- **Active Sorting**: Visual indication of current sort field and direction

### Sorting Behavior

- **Default**: Holdings sorted by value (highest first)
- **Token**: Alphabetical by name (A-Z, Z-A)
- **Amount**: Numeric (smallest to largest, largest to smallest)
- **Price**: Numeric (cheapest to most expensive, most expensive to cheapest)
- **Value**: Numeric (lowest to highest value, highest to lowest value)

### Performance

- **Efficient**: Uses `useMemo` to avoid unnecessary re-sorting
- **Dependencies**: Only re-sorts when data or sort settings change
- **Type Safety**: Full TypeScript support with proper typing

## Technical Details

### DataTable Component Integration

- **Reusable**: Uses existing DataTable component with sorting support
- **Consistent**: Same sorting UX as Holdings page
- **Type Safe**: Proper TypeScript interfaces maintained

### Edge Cases Handled

- **Missing Prices**: Price sorting treats missing prices as 0
- **String Sorting**: Case-insensitive alphabetical sorting for token names
- **Numeric Sorting**: Proper number comparison for amounts, prices, and values

## Testing

- ✅ **TypeScript**: All type checks pass
- ✅ **Build**: Production build succeeds
- ✅ **Runtime**: No runtime errors expected
- 🔄 **Manual Testing Recommended**:
  - Visit account details page
  - Click column headers to sort
  - Verify sorting works for all columns
  - Check that summary cards update correctly

## Related Files

- `apps/frontendV2/src/pages/AccountDetail.tsx` - Main implementation
- `apps/frontendV2/src/components/ui/data-table.tsx` - DataTable component
- `apps/frontendV2/src/pages/Holdings.tsx` - Reference implementation pattern

## Future Enhancements

1. **Persistent Sorting**: Remember user's sort preference per account
2. **Multi-column Sort**: Allow secondary sort criteria
3. **Sort Indicators**: Show up/down arrows for current sort direction
4. **Keyboard Navigation**: Arrow key navigation for accessibility
   </content>
   </xai:function_call name="filePath">/Users/mgrin/Projects/mgrin/scani/docs/technical/ACCOUNT_DETAILS_SORTING_ENHANCEMENT.md
