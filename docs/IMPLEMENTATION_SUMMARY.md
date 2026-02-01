# Implementation Summary: Show and Restore Removed Holdings Feature

## Overview
Implemented a feature that allows users to view and restore removed holdings from wallet accounts. Holdings from blockchain sources are soft-deleted (flagged as hidden) instead of being permanently deleted, because they are automatically recreated during wallet syncs.

## Implementation Details

### Backend Changes

#### 1. Updated Holdings Query to Support Hidden Holdings
**File:** `apps/backend/src/presentation/routers/accounts.ts`
- Modified `getHoldings` endpoint to accept an optional `includeHidden` boolean parameter
- When `includeHidden` is true, the query returns all holdings including hidden ones
- Default behavior (false) maintains backward compatibility

#### 2. Added Restore Endpoint
**File:** `apps/backend/src/presentation/routers/holdings.ts`
- Added new `restore` mutation endpoint
- Validates holding ownership and checks if holding is actually hidden
- Sets `isHidden` flag to false to restore the holding
- Emits real-time update events for UI synchronization

#### 3. Service Layer Updates
**Files:**
- `packages/core/src/features/implementations.ts`
- `packages/core/src/services/HoldingService.ts`

Changes:
- Added `includeHidden` parameter propagation through service layers
- Implemented `restore` method in HoldingImplementations
- Repository layer already supported `includeHidden` parameter

#### 4. Type Definition Updates
**File:** `packages/shared/src/dtos/holding.ts`
- Added `isHidden: boolean` field to `HoldingWithDetails` type
- Added `source: string` field to `HoldingWithDetails` type
- These fields are now returned in API responses

### Frontend Changes

#### 1. Account Detail Page Updates
**File:** `apps/frontendV2/src/pages/AccountDetail.tsx`

Key changes:
- Added `showHidden` state to track toggle status
- Added checkbox toggle "Show removed holdings" in the filters section
- Toggle only visible for wallet accounts (accounts with `walletAddress` in metadata)
- Updated holdings query to pass `includeHidden` parameter
- Added restore mutation with proper cache invalidation

#### 2. Visual Indicators
- Added "Removed" badge next to token symbol for hidden holdings
- Badge appears in both table and card views
- Styled with muted colors for clear differentiation

#### 3. Action Menu Updates
- Hidden holdings show "Restore Holding" action with Undo icon (green)
- Visible holdings show "Remove Holding" action with Trash icon (red)
- Actions are contextual based on `isHidden` status

#### 4. Filter Integration
- "Show removed holdings" toggle integrated into filters card
- Checkbox only appears for wallet accounts
- Clear filters button now resets the toggle

## User Flow

### Scenario 1: Viewing Removed Holdings
1. User navigates to a wallet account detail page
2. User sees "Show removed holdings" checkbox in filters section
3. User checks the checkbox
4. Holdings list refreshes to show both active and removed holdings
5. Removed holdings display with a "Removed" badge

### Scenario 2: Restoring a Hidden Holding
1. User enables "Show removed holdings" toggle
2. User clicks the action menu (⋯) for a removed holding
3. User clicks "Restore Holding" option
4. Holding is restored and "Removed" badge disappears
5. Toast notification confirms successful restoration

### Scenario 3: Non-Wallet Account
1. User navigates to a non-wallet account (manual, exchange, etc.)
2. "Show removed holdings" toggle is NOT visible
3. Regular delete behavior works as before (permanent deletion for manual holdings)

## Technical Notes

### Soft Delete Logic
- **Blockchain holdings:** Set `isHidden = true` (soft delete)
  - Reason: Holdings auto-sync from blockchain, would be recreated
  - Cron jobs continue to update hidden holdings
  - Hidden holdings excluded from portfolio calculations

- **Manual holdings:** Permanently deleted
  - Reason: User manually created, won't be recreated
  - Standard delete operation applies

### Mobile Considerations
- Checkbox and labels are touch-friendly
- Clear visual feedback for all states
- Responsive layout adjusts for mobile screens
- Actions remain easily accessible in both views

## Testing Checklist

### Backend Testing
- [ ] GET `/accounts/:id/holdings?includeHidden=false` - Returns only visible holdings
- [ ] GET `/accounts/:id/holdings?includeHidden=true` - Returns all holdings
- [ ] POST `/holdings/restore` with valid hidden holding - Successfully restores
- [ ] POST `/holdings/restore` with non-hidden holding - Returns error
- [ ] POST `/holdings/restore` with unauthorized holding - Returns error
- [ ] Verify `isHidden` and `source` fields in response

### Frontend Testing
- [ ] Wallet account shows "Show removed holdings" toggle
- [ ] Non-wallet account does NOT show toggle
- [ ] Toggle OFF - Only visible holdings shown
- [ ] Toggle ON - All holdings shown including removed
- [ ] Hidden holdings show "Removed" badge in table view
- [ ] Hidden holdings show "Removed" badge in card view
- [ ] Action menu shows "Restore" for hidden holdings
- [ ] Action menu shows "Remove" for visible holdings
- [ ] Restore action successfully unhides holding
- [ ] Toast notification appears on successful restore
- [ ] Clear filters resets toggle to OFF

### Integration Testing
- [ ] Remove a blockchain holding → verify isHidden = true
- [ ] Enable toggle → verify removed holding appears
- [ ] Restore holding → verify isHidden = false
- [ ] Disable toggle → verify restored holding remains visible
- [ ] Multiple holdings can be restored in sequence
- [ ] Real-time updates work correctly

## Files Modified

### Backend
1. `apps/backend/src/presentation/routers/accounts.ts`
2. `apps/backend/src/presentation/routers/holdings.ts`
3. `packages/core/src/features/implementations.ts`
4. `packages/core/src/services/HoldingService.ts`
5. `packages/shared/src/dtos/holding.ts`

### Frontend
1. `apps/frontendV2/src/pages/AccountDetail.tsx`

## Security Considerations
- ✅ User authentication required for all endpoints
- ✅ Ownership validation before restore
- ✅ Hidden status validation before restore
- ✅ Proper error handling for edge cases
- ✅ Type safety maintained throughout

## Performance Considerations
- ✅ No additional database queries (uses existing repository methods)
- ✅ Efficient cache invalidation strategy
- ✅ Minimal frontend re-renders
- ✅ Toggle state persists during page interaction

## Future Enhancements
- Bulk restore operation
- Filter to show only removed holdings
- Undo restore action
- Audit log of hide/restore actions
- Notification when hidden holding value changes significantly
