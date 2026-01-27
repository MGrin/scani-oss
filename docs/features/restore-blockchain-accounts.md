# Restore Blockchain Accounts Feature

## Overview

This feature allows users to restore previously removed blockchain accounts for their crypto wallets. Similar to the existing "restore hidden holdings" functionality, users can now restore blockchain/chain accounts that were previously deleted.

## Background

In Scani's architecture:
- Each crypto wallet can exist on multiple blockchains (Ethereum, Solana, Bitcoin, etc.)
- Each blockchain presence is represented as a separate **account** in the system
- When a user deletes a blockchain account, the institution is removed from the wallet's `institutionIds` array
- The account itself remains in the database but is effectively "ignored" for that wallet
- Previously, there was no way to restore these removed blockchains

## User Flow

### Removing a Blockchain Account
1. User navigates to an account detail page for a blockchain account (e.g., "My Wallet - Ethereum")
2. User clicks "Delete Account" 
3. System removes the institution (Ethereum) from the wallet's `institutionIds` array
4. The account still exists in the database but is no longer included in wallet syncs

### Restoring a Blockchain Account
1. User navigates to the removed blockchain account's detail page
2. User sees a "Restore Chain" button in the page header (green-colored)
3. User clicks "Restore Chain"
4. System adds the institution back to the wallet's `institutionIds` array
5. Toast notification confirms: "Blockchain restored - The blockchain has been successfully restored to your wallet"
6. The "Restore Chain" button disappears
7. The blockchain will be included in future wallet syncs

## Technical Implementation

### Backend

**Repository Layer** (`packages/core/src/repositories/AccountRepository.ts`):
- Added `findByUserWalletId()` method to find accounts by user_wallet_id
- Uses database-level JSONB query for efficient filtering:
  ```sql
  metadata->>'userWalletId' = ${userWalletId}
  ```

**Service Layer** (`packages/core/src/features/implementations.ts`):
- `AccountImplementations.restore()`:
  - Validates account ownership
  - Checks if account is a wallet account (has `userWalletId` and `migrated` in metadata)
  - Verifies the institution isn't already active
  - Calls `UserWalletService.addInstitutionToWallet()` to restore
- `AccountImplementations.getByWalletId()`:
  - Queries accounts for a specific wallet
  - Supports `includeRemoved` flag to show/hide removed blockchain accounts

**Router Layer** (`apps/backend/src/presentation/routers/accounts.ts`):
- `accounts.restore` mutation endpoint
- `accounts.getByWalletId` query endpoint
- Both endpoints emit WebSocket events for real-time updates

### Frontend

**AccountDetail Page** (`apps/frontendV2/src/pages/AccountDetail.tsx`):
- Added `restoreAccountMutation` with proper cache invalidation
- Added "Restore Chain" button conditionally displayed for wallet accounts
- Button visibility controlled by:
  - `isWalletAccount`: true if account has `walletAddress` and `migrated` in metadata
  - `accountRestored`: state to hide button after successful restore
- Toast notification on successful restore
- Error handling with user-friendly messages

## Database Schema

### Accounts Table
```typescript
{
  id: UUID,
  userId: UUID,
  institutionId: UUID,
  metadata: JSONB {
    walletAddress: string,      // Blockchain wallet address
    userWalletId: string,        // Reference to user_wallets.id
    migrated: boolean,           // Flag indicating wallet migration complete
    chainName: string,           // e.g., "Ethereum", "Bitcoin"
    // ... other metadata
  }
}
```

### UserWallets Table
```typescript
{
  id: UUID,
  userId: UUID,
  walletAddress: string,
  institutionIds: JSONB Array,   // Array of active institution IDs
  label: string,
  isActive: boolean
}
```

## API Endpoints

### `accounts.restore`
**Type**: Mutation  
**Input**: `{ id: string }`  
**Output**: Updated account object  
**Errors**:
- "Account not found"
- "Unauthorized: Account does not belong to user"
- "Account is not a wallet account"
- "User wallet not found"
- "This account is already active for the wallet"

### `accounts.getByWalletId`
**Type**: Query  
**Input**: `{ walletId: string, includeRemoved?: boolean }`  
**Output**: Array of account objects  
**Errors**:
- "Wallet not found"
- "Unauthorized: Wallet does not belong to user"

## Edge Cases & Validation

1. **Account doesn't belong to user**: Returns "Unauthorized" error
2. **Account isn't a wallet account**: Returns "Account is not a wallet account" error
3. **Wallet doesn't exist**: Returns "User wallet not found" error
4. **Institution already active**: Returns "This account is already active for the wallet" error
5. **Missing institutionId**: Silently handles (shouldn't happen in practice)

## Security Considerations

1. **Authorization**: All operations verify user ownership of both account and wallet
2. **Data Integrity**: Validates account metadata structure before restoration
3. **SQL Injection**: Uses parameterized queries via Drizzle ORM
4. **Input Validation**: UUID validation via Zod schemas

## Testing Plan

### Manual Testing

1. **Happy Path - Restore a removed blockchain**:
   - Import a multi-chain wallet (e.g., 0x address on Ethereum and Polygon)
   - Delete the Polygon account
   - Navigate to the deleted Polygon account page
   - Verify "Restore Chain" button is visible
   - Click "Restore Chain"
   - Verify success toast appears
   - Verify button disappears
   - Verify Polygon appears in wallet sync again

2. **Error Case - Restore already active blockchain**:
   - Import a wallet with Ethereum
   - Navigate to Ethereum account (already active)
   - Click "Restore Chain"
   - Verify error message appears

3. **Edge Case - Non-wallet account**:
   - Create a manual account (not from wallet)
   - Navigate to account detail page
   - Verify "Restore Chain" button is NOT visible

### Automated Testing (Future)

```typescript
describe('AccountImplementations.restore', () => {
  it('should restore a removed blockchain account', async () => {
    // Test implementation
  });
  
  it('should throw error if account not found', async () => {
    // Test implementation
  });
  
  it('should throw error if account not owned by user', async () => {
    // Test implementation
  });
  
  it('should throw error if account is not a wallet account', async () => {
    // Test implementation
  });
  
  it('should throw error if blockchain already active', async () => {
    // Test implementation
  });
});
```

## Future Enhancements

1. **Bulk Restore**: Add ability to restore multiple blockchain accounts at once
2. **Restore from Accounts List**: Add "Restore" action to accounts list page
3. **Show Removed Chains**: Add toggle on Accounts page to show/hide removed blockchain accounts
4. **Wallet Management Page**: Create dedicated page to manage all blockchains for a wallet
5. **Automatic Detection**: Detect and suggest restoring blockchains with new activity

## Related Features

- **Delete Holding**: Similar soft-delete pattern for holdings
- **Restore Holding**: Existing feature that inspired this implementation
- **Wallet Import**: Creates initial blockchain accounts when importing wallet
- **Sync Wallet Balances**: Only syncs active blockchain accounts (filtered by institutionIds)

## Changelog

- **2026-01-27**: Initial implementation of restore blockchain accounts feature
