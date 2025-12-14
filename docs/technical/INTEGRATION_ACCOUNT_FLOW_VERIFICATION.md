# Integration Account Flow Verification

## Overview
This document validates the complete flow for accounts created via integrations, covering wallet import and sync operations.

## 1. Wallet Import Flow - Using Integration Package

### 1.1 Import Entry Point
**File**: `packages/core/src/use-cases/ImportWalletAddressUseCase.ts`

When importing a wallet, the use case follows this flow:

1. **Get user info** (line 93)
   - Validates user exists
   - Sets up for wallet creation

2. **Use integrations package** (line 101)
   - Calls `executeWithIntegrations()` method
   - All new wallet imports use the integration-based approach (legacy code paths removed)

### 1.2 Chain Activity Detection

**Files**:
- `packages/integrations/src/IntegrationManager.ts:detectWalletChains()` (line 198)
- `packages/integrations/src/implementations/BlockchainIntegration.ts:hasActivity()` (line 206)

**Process**:
1. Get all active institution-to-chain mappings from database
2. For each mapping, get the corresponding integration
3. Call `integration.hasActivity(address)` to check for activity on each chain
4. **Key implementation**:
   - For EVM chains: Uses Etherscan's `hasActivity` method if available
   - Fallback: Fetches token balances - if any exist, wallet has activity
   - Non-EVM chains: Always use balance fallback method

```typescript
// From BlockchainIntegration.ts line 206-225
async hasActivity(address: string): Promise<boolean> {
  if (!this.blockchainService.isValidAddress(address)) return false;
  
  // Etherscan has direct activity check
  if (this.blockchainService.hasActivity) {
    return await this.blockchainService.hasActivity(address);
  }
  
  // Fallback: check if wallet has any token balances
  const balances = await this.blockchainService.getTokenBalances(address);
  return balances.length > 0;
}
```

**Result**: Only institutions/chains where activity is detected are included for account creation.

### 1.3 User Wallet Record Creation

**Location**: `ImportWalletAddressUseCase.ts` lines 158-190

The system creates/updates a `user_wallets` table entry:
- `walletAddress`: The imported wallet address
- `institutionIds`: Array of chain IDs where activity was detected
- `label`: Optional display name
- `isActive`: Set to true

This is the persistent link between a user and their wallet across all chains.

### 1.4 Account Creation Per Chain

**Location**: `ImportWalletAddressUseCase.ts` lines 224-326

For each detected institution/chain:

1. **Get integration** (line 228)
   - Load the appropriate integration (EVM, Bitcoin, Solana, etc.)

2. **Get institution details** (line 242-256)
   - Fetch institution record from database
   - Get blockchain mapping to find chain info

3. **Check/create account** (line 417-485)
   - Look for existing account with same institution and wallet address
   - If exists: Update metadata with `userWalletId` and `migrated: true` flag
   - If not exists: Create new account with:
     - `metadata.walletAddress`: The wallet address
     - `metadata.chainId`: Blockchain chain ID
     - `metadata.chainName`: Chain name
     - `metadata.userWalletId`: Reference to user_wallet record
     - `metadata.migrated: true`: Marks as new system account
     - `description`: "Crypto wallet on [chain name]"

4. **Store integration credentials** (line 487-514)
   - For blockchain integrations, stores a marker indicating public RPC access
   - Not critical if fails (non-blocking)

**Result**: One account created per chain where activity exists.

### 1.5 Holdings Creation

**Location**: `ImportWalletAddressUseCase.ts` lines 516-682

For each account on each chain:

1. **Fetch holdings from integration** (line 381)
   - Calls `integration.fetchHoldings(walletAddress)`
   - Returns all token balances for the wallet on that chain

2. **Process each token** (line 529-663)
   - Skip tokens with missing symbol or balance
   - Validate balance is a valid decimal string (using decimal.js compatible format)
   
3. **Map token to Scani format** (line 569)
   - Calls `integration.mapToken(holding)`
   - Converts blockchain token data to standard Scani token format
   - Includes blockchain metadata (chain ID, contract address, decimals, etc.)

4. **Find or create token** (line 572-575)
   - Uses `TokenService.findOrCreateTokenFromIntegration()`
   - Looks up token by symbol and blockchain metadata
   - Creates new token entry if needed

5. **Check for existing holding** (line 588-595)
   - Includes hidden holdings in search (parameter: `includeHidden: true`)
   - Important: Allows recovery of holdings if they become active again

6. **Create or update holding** (line 597-663)
   - If holding exists: Update balance and unhide if it was hidden
   - If not exists: Create new holding with:
     - `source: 'blockchain'`: Indicates blockchain-sourced data
     - `balance`: Token balance from chain
     - `isHidden: false`

**Result**: All token holdings created for all tokens on all chains.

**Note on prices**: Token prices are NOT fetched during import (line 665-666) to improve performance.

---

## 2. Sync Wallet Balances Flow

### 2.1 Sync Entry Point
**File**: `packages/core/src/use-cases/SyncWalletBalancesUseCase.ts`

Designed as a cron job that:
- Syncs all wallet accounts periodically
- Maintains balance accuracy
- Creates/updates/deletes holdings as needed

### 2.2 Wallet Discovery

**Location**: `SyncWalletBalancesUseCase.ts` lines 144-165

1. **Get all users** (line 160)
   - Query all user records

2. **For each user, get their wallets** (line 164)
   - From `user_wallets` table

3. **For each wallet, get institutions** (line 167)
   - Use `institutionIds` array from user_wallet record

**Result**: Processes only wallets that were explicitly imported (via user_wallets).

### 2.3 Chain Activity Re-verification

**Location**: `SyncWalletBalancesUseCase.ts` lines 171-191

For each institution in the wallet's institution IDs:
- Get the integration
- Verify integration exists
- Get institution record
- Proceed if available

This ensures we only sync chains that still have integrations.

### 2.4 Account Lookup

**Location**: `SyncWalletBalancesUseCase.ts` lines 194-216

Find the specific account for this wallet + institution combination:
1. Query accounts where `userId` and `institutionId` match
2. Filter to account where `metadata.userWalletId` matches the current user_wallet
3. Ensures we sync the correct account (handles multiple wallets per user)

### 2.5 Fetch Current Balances

**Location**: `SyncWalletBalancesUseCase.ts` lines 227-243

1. Call `integration.fetchHoldings(walletAddress)`
   - Gets all current token balances from blockchain
   - May include new tokens not previously held

2. Handle errors gracefully
   - Log errors but continue processing
   - Report failed chains in result

### 2.6 Balance Update Strategy

**Location**: `SyncWalletBalancesUseCase.ts` lines 245-385

The system uses an efficient strategy to handle three scenarios:

#### Strategy: Map Existing Holdings
**Lines 246-264**:
```typescript
// Get existing holdings for this account
const existingHoldings = await this.holdingService.findByAccount(
  account.id,
  undefined,
  true  // Include hidden holdings
);

// Create map of existing holdings by token symbol
const existingHoldingsMap = new Map<string, Holding>();
for (const holding of existingHoldings) {
  const token = tokensMap.get(holding.tokenId);
  if (token) {
    existingHoldingsMap.set(token.symbol.toUpperCase(), holding);
  }
}
```

This allows fast lookup to determine if a token is already tracked.

#### Scenario 1: Balance Goes to Zero
**Lines 309-324**:
- Holding exists with zero balance: Update balance to 0, count as removal if not hidden
- Holding doesn't exist: No action needed
- Hidden holdings: Updated but remain hidden

**Key behavior**: Zero balance holdings are kept (not deleted) to preserve history for future syncs. This is intentional design.

#### Scenario 2: Balance is Non-Zero, Holding Exists
**Lines 327-340**:
- Call `holdingService.updateHoldingBalance(holdingId, balance)`
- Updates balance and timestamp
- Does NOT change hidden state
- Count as update if not hidden (respects user's visibility preference)

**From HoldingRepository.ts line 327-345**:
```typescript
async updateBalance(holdingId: string, balance: string) {
  await database
    .update(schema.holdings)
    .set({
      balance,
      lastUpdated: new Date(),
    })
    .where(eq(schema.holdings.id, holdingId));
}
```

#### Scenario 3: New Token Discovered
**Lines 341-368**:
- Token doesn't exist in holdings: Create new holding
- Source: `'blockchain'` (blockchain-sourced)
- Hidden: `false` (visible by default)
- Balance: Current balance from chain
- Count as creation

#### Token Processing
**Lines 267-304**:
1. Map blockchain token to Scani format using integration
2. Find or create token record (reuses existing tokens)
3. Look up in existing holdings map by symbol
4. Execute appropriate scenario

### 2.7 Account Metadata Update

**Location**: `SyncWalletBalancesUseCase.ts` lines 387-392

After syncing each account:
```typescript
const metadata = account.metadata as Record<string, unknown>;
await this.accountService.updateAccountMetadata(account.id, {
  ...metadata,
  lastSync: new Date().toISOString(),
});
```

Tracks when each account was last synced.

### 2.8 Sync Result Tracking

**Location**: `SyncWalletBalancesUseCase.ts` lines 35-56

Returns comprehensive metrics:
- `accountsFound`: Total wallet + chain combinations found
- `accountsSynced`: Successfully synced
- `accountsFailed`: Failed to sync
- `holdingsUpdated`: Holdings with balance changes (non-hidden)
- `holdingsCreated`: New tokens discovered
- `holdingsRemoved`: Holdings that went to zero balance
- `errors`: Detailed error logs per account
- `durationMs`: Operation duration

---

## 3. Data Model Integration

### 3.1 User Wallets Table
**Purpose**: Persistent storage of imported wallets

```
user_wallets:
  - id
  - userId
  - walletAddress
  - institutionIds: Array<string>  // Chains where activity detected
  - label: Optional display name
  - isActive: boolean
```

### 3.2 Accounts Table
**Purpose**: Account for each chain a wallet exists on

```
accounts:
  - id
  - userId
  - institutionId
  - name
  - typeId: (crypto account type)
  - metadata:
      - walletAddress: The blockchain address
      - chainId: Blockchain chain ID
      - chainName: Chain name
      - userWalletId: Reference to user_wallet record
      - migrated: true (indicates new system)
      - lastSync: ISO timestamp
```

### 3.3 Holdings Table
**Purpose**: Token balances for each account

```
holdings:
  - id
  - userId
  - accountId
  - tokenId
  - balance: Decimal string
  - source: 'blockchain' (indicates source)
  - isHidden: boolean (user preference)
  - lastUpdated: Timestamp
```

---

## 4. Integration Architecture

### 4.1 Integration Manager
**File**: `packages/integrations/src/IntegrationManager.ts`

Responsibilities:
- Load integrations by institution ID
- Detect wallet chains via `detectWalletChains(address)`
- Cache integrations for performance
- Manage rate limiters per blockchain

### 4.2 Blockchain Integration Base Class
**File**: `packages/integrations/src/implementations/BlockchainIntegration.ts`

Methods:
- `fetchHoldings(address)`: Get all token balances
- `mapToken(holding)`: Convert to Scani format
- `hasActivity(address)`: Check if wallet exists on chain
- `fetchAccounts()`: Get wallet addresses for user

### 4.3 Chain-Specific Implementations

- **EvmChainIntegration**: Ethereum and EVM-compatible chains (Etherscan API)
- **BitcoinIntegration**: Bitcoin blockchain (blockchain.info)
- **SolanaIntegration**: Solana blockchain
- **TronIntegration**: Tron blockchain
- **TonIntegration**: TON blockchain

Each provides:
- Chain-specific API client
- Address validation
- Token balance fetching
- Activity detection

---

## 5. Key Design Patterns

### 5.1 Decimal.js for Balance Values
All balance values are stored and manipulated as decimal strings compatible with decimal.js:
- `isValidDecimalString()` validates format before storage
- No floating-point math errors
- Maintains precision for financial calculations

### 5.2 Soft Delete Pattern (Hidden Holdings)
Holdings are never permanently deleted. Instead:
- `isHidden: true` marks hidden holdings
- Hidden holdings can be recovered if tokens reappear
- Respects user's visibility preferences

### 5.3 User Wallet Persistence
The `user_wallets` table is the source of truth:
- Tracks which chains a wallet is on (`institutionIds`)
- Enables efficient sync operations
- Supports multiple wallets per user
- Link between imports and accounts

### 5.4 Account Metadata
Metadata field stores blockchain-specific info:
- `walletAddress`: For validation
- `chainId`, `chainName`: For UI display
- `userWalletId`: Link to user_wallet record
- `migrated: true`: Marks as new system account
- `lastSync`: Track sync timing

### 5.5 Rate Limiting
Global rate limiters per blockchain prevent API limits:
- Etherscan: 7 calls/sec
- Bitcoin: 1 call/10 sec
- Solana: 10 calls/sec
- Tron: 20 calls/sec
- TON: 1 call/sec

---

## 6. Error Handling

### 6.1 Import Flow Errors
**Location**: `ImportWalletAddressUseCase.ts` lines 307-325

- Per-institution error tracking
- Continues processing other institutions if one fails
- Returns detailed error list to caller
- Non-blocking individual token failures

### 6.2 Sync Flow Errors
**Location**: `SyncWalletBalancesUseCase.ts` lines 395-411

- Per-account error tracking
- Continues with next account if one fails
- Includes wallet address in error for debugging
- Overall operation completion metric

### 6.3 Token Processing Errors
**Location**: Both files, token processing loops

- Non-blocking per-token failures
- Continue with other tokens in same wallet
- Logged for debugging

---

## 7. Performance Considerations

### 7.1 Parallel Chain Detection
**Location**: `IntegrationManager.detectWalletChains()` line 217-257

```typescript
const checks = mappings.map(async (mapping) => {
  // Check each chain in parallel
});
const results = await Promise.all(checks);
```

- Parallel checks across all chains
- Significantly faster than sequential checking

### 7.2 Batch Token Lookups
**Location**: `SyncWalletBalancesUseCase.ts` lines 252-264

```typescript
const existingTokenIds = existingHoldings.map((h) => h.tokenId);
const existingTokens = await this.tokenService.getTokensByIds(existingTokenIds);
const tokensMap = new Map(existingTokens.map((t) => [t.id, t]));
```

- Single batch fetch of all tokens
- Map for O(1) lookups vs repeated database queries

### 7.3 Price Fetching Deferred
**Both files**: Removed from import/sync flows

- Prices fetched on-demand when user views portfolio
- Significant performance improvement
- Separates data sync from price updates

### 7.4 Integration Caching
**Location**: `IntegrationManager.ts` lines 77-80

```typescript
if (this.integrationCache.has(institutionId)) {
  return this.integrationCache.get(institutionId);
}
```

- Avoids recreating integrations per wallet
- Reuses rate limiter instances

---

## 8. Validation Checklist

- ✅ **Chain Activity Detection**: Uses integration's `hasActivity()` method
  - EVM chains: Etherscan direct check
  - Non-EVM: Token balance fallback
  - Only creates accounts on chains with activity

- ✅ **Account Creation**: One per detected chain
  - Stores `userWalletId` in metadata
  - Marked as `migrated: true`
  - Stores chain and wallet info in metadata

- ✅ **Holdings Creation**: All tokens on all chains
  - Created during import with `source: 'blockchain'`
  - Includes all tokens with non-zero balance

- ✅ **Sync Balance Updates**: Efficient three-scenario handling
  - Scenario 1: Existing + zero balance → Update to 0
  - Scenario 2: Existing + non-zero → Update balance
  - Scenario 3: New token → Create holding

- ✅ **Zero Balance Handling**: Kept for history
  - Not deleted
  - Not counted in removal metric for hidden holdings
  - Preserved for future sync accuracy

- ✅ **New Token Discovery**: Automatic during sync
  - Holdings created for new tokens
  - Source: `'blockchain'`
  - Counted in `holdingsCreated` metric

- ✅ **Hidden Holdings Preserved**: Respects user intent
  - Hidden holdings updated with new balance
  - Remain hidden after update
  - Not counted in metrics if hidden

- ✅ **Decimal.js Used**: All balance calculations
  - Validated as decimal strings
  - No floating-point errors
  - Type-safe conversions

---

## 9. Summary

The integration-based wallet import and sync flow is well-designed and properly implemented:

1. **Import Phase**: Uses integrations package to detect chains with activity, creates persistent user_wallet record, creates one account per chain, initializes all token holdings.

2. **Sync Phase**: Efficiently updates balances for all tracked wallets, discovers new tokens, handles zero balances, preserves history, respects user preferences for hidden holdings.

3. **Data Integrity**: Uses decimal.js for all financial calculations, maintains referential integrity via userWalletId, uses soft deletes for holdings.

4. **Performance**: Parallel chain detection, batch token lookups, integration caching, deferred price fetching.

5. **Error Handling**: Graceful per-institution/account errors, continues processing, provides detailed metrics.

All specified requirements are met:
- ✅ Chain activity tested for all chains
- ✅ Accounts created only where activity exists
- ✅ Holdings created for every token
- ✅ During sync: balances updated, zero holdings kept, new holdings created
