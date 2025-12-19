# Holding Exclusion Feature

## Overview

This feature allows users to mark holdings as "inactive" to exclude them from total balance calculations while keeping them visible in the UI. This is useful for holdings that users want to track but not include in their portfolio totals (e.g., locked tokens, test accounts, deprecated assets).

## Implementation Details

### Database Schema Changes

**Migration:** `0020_empty_luke_cage.sql`

Added `isActive` boolean field to the `holdings` table:
- Default value: `true` (all existing holdings remain active)
- Indexed for efficient filtering in calculations
- Independent from `isHidden` field (which completely hides holdings)

```sql
ALTER TABLE "holdings" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;
CREATE INDEX "idx_holdings_is_active" ON "holdings" USING btree ("is_active");
```

### Backend Changes

#### DTOs & Types
- **UpdateHoldingDto** (`packages/shared/src/dtos/holding.ts`):
  - Added optional `isActive` field to update schema
  - Made `balance` field optional to allow updating only status

- **HoldingWithDetails** (`packages/shared/src/dtos/holding.ts`):
  - Added `isActive: boolean` field to response type

#### Use Cases & Services
- **UpdateHoldingUseCase** (`packages/core/src/use-cases/UpdateHoldingUseCase.ts`):
  - Updated input interface to accept `isActive` field
  - Handles toggling active status for holdings

- **PortfolioValuationService** (`packages/core/src/services/PortfolioValuationService.ts`):
  - Added filter condition: `eq(schema.holdings.isActive, true)`
  - Inactive holdings are excluded from total portfolio value calculations

- **GetAssetAllocationUseCase** (`packages/core/src/use-cases/GetAssetAllocationUseCase.ts`):
  - Added check to skip inactive holdings in allocation calculations
  - Ensures percentages only reflect active holdings

- **HoldingService** (`packages/core/src/services/HoldingService.ts`):
  - Includes `isActive` field in holding details response

- **HoldingRepository** (`packages/core/src/repositories/HoldingRepository.ts`):
  - Updated select queries to include `isActive` field
  - Added to holding object mapping

### Frontend Changes

#### HoldingModal Component
**File:** `apps/frontendV2/src/components/features/HoldingModal.tsx`

Added interactive toggle for marking holdings as active/inactive:
- Checkbox control labeled "Include in total balance calculations"
- State management for `editIsActive` field
- Updated save handler to include `isActive` in update data
- Added helper text explaining the feature when unchecked
- Change detection includes `isActive` status

```tsx
<Checkbox
  id="isActive"
  checked={editIsActive}
  onCheckedChange={(checked) => setEditIsActive(checked === true)}
/>
<Label htmlFor="isActive">
  Include in total balance calculations
</Label>
```

#### Holdings Page
**File:** `apps/frontendV2/src/pages/Holdings.tsx`

Added status column to holdings table:
- Shows "Active" badge (green) for active holdings
- Shows "Inactive" badge (gray) for inactive holdings
- Visual indication helps users quickly identify excluded holdings

## User Experience

### Marking a Holding as Inactive

1. Navigate to Holdings page
2. Click on a holding to open the detail modal
3. Uncheck "Include in total balance calculations"
4. Click "Save Changes"
5. Holding remains visible but is now excluded from:
   - Total portfolio value
   - Asset allocation charts
   - Dashboard statistics

### Status Indicators

- **Active Badge (Green):** Holding is included in all calculations
- **Inactive Badge (Gray):** Holding is visible but excluded from totals

## Technical Considerations

### Difference from `isHidden`

| Field | Purpose | Visibility | In Calculations |
|-------|---------|------------|-----------------|
| `isHidden` | Completely hide holdings (e.g., zero-balance holdings) | Hidden from UI | Excluded |
| `isActive` | Exclude from totals while keeping visible | Visible in UI | Excluded if false |

### Database Queries

All calculation queries now filter by `isActive = true`:
- Portfolio valuation queries
- Asset allocation aggregations
- Dashboard overview statistics

User-facing list queries (Holdings page) include inactive holdings to maintain visibility.

### Performance

- Indexed `isActive` field ensures efficient filtering
- No impact on query performance for active holdings
- Minimal overhead for displaying inactive status

## Migration Notes

**For Users:**
- All existing holdings default to `isActive = true`
- No action required - existing behavior is preserved
- Users can opt-in to exclude specific holdings

**For Database:**
- Migration adds column with default value (non-breaking)
- Index created for performance
- No data migration required

## Testing Recommendations

1. **Functional Tests:**
   - Toggle holding active/inactive status
   - Verify totals exclude inactive holdings
   - Verify inactive holdings remain visible in lists

2. **Edge Cases:**
   - All holdings marked inactive (total should be zero)
   - Mixed active/inactive holdings
   - Updating other fields while changing status

3. **UI/UX Tests:**
   - Status badges display correctly
   - Checkbox state persists correctly
   - Helper text appears when appropriate

## Future Enhancements

Potential improvements for future iterations:

1. **Bulk Operations:**
   - Mark multiple holdings as inactive simultaneously
   - Filter view to show only active/inactive holdings

2. **Reporting:**
   - Separate reports for active vs inactive holdings
   - Track when holdings were marked inactive

3. **Automation:**
   - Auto-mark holdings as inactive when balance reaches zero
   - Time-based activation (e.g., unlock date for locked tokens)

## Related Files

### Backend
- `packages/core/src/database/schema.ts` - Schema definition
- `packages/core/src/database/migrations/0020_empty_luke_cage.sql` - Migration
- `packages/core/src/services/PortfolioValuationService.ts` - Total calculations
- `packages/core/src/use-cases/GetAssetAllocationUseCase.ts` - Asset allocation
- `packages/core/src/use-cases/UpdateHoldingUseCase.ts` - Update logic
- `packages/shared/src/dtos/holding.ts` - Type definitions

### Frontend
- `apps/frontendV2/src/components/features/HoldingModal.tsx` - Toggle UI
- `apps/frontendV2/src/pages/Holdings.tsx` - Status display
