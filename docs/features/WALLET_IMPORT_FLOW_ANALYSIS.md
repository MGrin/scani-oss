# Wallet Import Flow Analysis

**Date**: October 2, 2025  
**Status**: Gap Analysis

## Ideal Flow (User Requirements)

### User Journey

1. **User inputs wallet address** (similar to screenshot upload, but no account selection needed)
2. **Frontend submits address to backend**
3. **Backend processes**:
   - Detect chain(s) the wallet exists on (multiple for EVM)
   - Create one account per chain where wallet has balance
   - Fetch all token balances on each chain
   - Create holdings for each token balance
4. **Result**: User has N accounts with K holdings
   - N = number of networks with non-zero balances
   - K = total number of different tokens across all chains

## Current Implementation Status

### ✅ What We Have

#### 1. Chain Detection & Balance Fetching

- **File**: `services/chain/multi-chain.ts`
- **Status**: ✅ Complete
- **Features**:
  - `detectAddressType()` - Identifies EVM, Bitcoin, Tron, or Solana
  - `getAllBalances()` - Fetches native token balances across all relevant chains
  - Returns array of `{ chainId, chainName, tokenSymbol, balance }`

#### 2. Multi-Chain Support

- **Files**: `services/chain/*.ts`
- **Status**: ✅ Complete
- **Chains Supported**:
  - 38 EVM chains (Ethereum, Polygon, Optimism, Arbitrum, Base, etc.)
  - Bitcoin mainnet
  - Tron mainnet
  - Solana mainnet
- **Native Token Support**: ✅ Complete (ETH, MATIC, BTC, TRX, SOL, etc.)

#### 3. Manual Account Creation

- **Endpoint**: `wallet.createWalletAccount`
- **Status**: ✅ Works but not ideal for this flow
- **Issues**:
  - Requires `institutionId` (user must select institution first)
  - Creates ONE account with metadata containing ALL chain IDs
  - Does NOT create separate accounts per chain
  - Does NOT create holdings automatically

#### 4. Holdings Router

- **File**: `routers/holdings.ts`
- **Status**: ✅ Has create/update logic
- **Features**:
  - `holdings.create` - Creates individual holding
  - `holdings.checkDuplicate` - Prevents duplicate holdings
  - Supports token lookup and validation

### ❌ What's Missing

#### 1. **Wallet Import Endpoint** ❌

**Required**: New endpoint `wallet.importWalletAddress`

**Input**:

```typescript
{
  walletAddress: string;
  name?: string; // Optional friendly name, default to "Wallet (0x...)"
}
```

**Logic**:

1. Detect address type
2. Fetch balances from all chains
3. For each chain with non-zero balance:
   - Find or create institution for that specific chain
   - Create account for that chain
   - For each token on that chain:
     - Find or create token in DB
     - Create holding with quantity

**Output**:

```typescript
{
  accountsCreated: number;
  holdingsCreated: number;
  accounts: Array<{
    id: string;
    name: string;
    chainName: string;
    holdings: Array<{
      id: string;
      tokenSymbol: string;
      quantity: string;
    }>;
  }>;
}
```

#### 2. **Chain-Specific Institutions** ⚠️

**Current Problem**:

- We have generic "crypto_wallet" institutions
- Need institutions like "Ethereum Wallet", "Polygon Wallet", "Bitcoin Wallet"

**Required**:

- Database seeding for chain-specific wallet institutions
- OR logic to create them dynamically on first use

#### 3. **ERC-20 Token Support** ❌

**Status**: Not implemented (Priority 2)

**Required**:

- Service to fetch ERC-20 token balances (not just native tokens)
- Token contract ABI integration
- Popular token detection (USDT, USDC, DAI, etc.)
- Token metadata resolution (decimals, logo, name)

**Impact**: Currently only native tokens (ETH, MATIC, BTC, TRX, SOL) are imported

#### 4. **Automatic Token Creation** ⚠️

**Current Status**: Holdings router requires `tokenId`

**Required**:

- Logic to find or create token by symbol/chain
- Handle token metadata (decimals, name, type)
- Link to external price APIs (Coingecko, etc.)

#### 5. **Bulk Operations** ❌

**Required**:

- Transaction wrapper for atomic account + holdings creation
- Rollback on partial failure
- Progress reporting for large wallets

## Comparison with Screenshot Parsing Flow

### Screenshot Parsing Pattern (Reference)

```typescript
screenshotParsing.parseScreenshot → Returns parsed holdings
screenshotParsing.processHoldingsFromParsing → Creates accounts + holdings
```

**Key Similarities Needed**:

1. Two-step process: detect → persist
2. Bulk account creation
3. Bulk holdings creation
4. Token matching/creation logic

**Key Differences**:

- Screenshot: User selects account first
- Wallet: No account selection, create per chain automatically

## Implementation Gaps Summary

| Feature                      | Status     | Priority | Effort   |
| ---------------------------- | ---------- | -------- | -------- |
| Wallet import endpoint       | ❌ Missing | P0       | 1 day    |
| Chain-specific institutions  | ⚠️ Partial | P0       | 0.5 day  |
| Multi-account creation logic | ❌ Missing | P0       | 0.5 day  |
| Bulk holdings creation       | ❌ Missing | P0       | 0.5 day  |
| Token find-or-create         | ⚠️ Manual  | P0       | 0.5 day  |
| ERC-20 token support         | ❌ Missing | P1       | 2-3 days |
| Transaction rollback         | ❌ Missing | P1       | 0.5 day  |
| ENS name support             | ❌ Missing | P2       | 1 day    |
| Frontend UI                  | ❌ Missing | P3       | 3-4 days |

**Total Effort for MVP (P0 only)**: ~3 days
**Total Effort for Full Feature (P0-P2)**: ~7-8 days

## Recommended Implementation Order

### Phase 1: MVP Wallet Import (P0) - 3 days

1. **Create chain-specific institutions** (0.5 day)

   - Add migration for 40+ wallet institutions
   - Map chainId → institutionId

2. **Build `wallet.importWalletAddress` endpoint** (1 day)

   - Detect address type
   - Fetch native token balances
   - Create account per chain
   - Create holdings for native tokens

3. **Add token find-or-create service** (0.5 day)

   - Match by symbol + chain
   - Create if missing with basic metadata

4. **Add bulk operations + transactions** (0.5 day)

   - Wrap in DB transaction
   - Rollback on failure

5. **Testing** (0.5 day)
   - Test with EVM multi-chain wallet
   - Test with Bitcoin address
   - Test with Tron/Solana addresses

### Phase 2: ERC-20 Tokens (P1) - 2-3 days

1. **ERC-20 service implementation**
2. **Token detection & balances**
3. **Integration with wallet import**

### Phase 3: Polish (P2) - 2 days

1. **ENS name resolution**
2. **Better error handling**
3. **Progress indicators**

### Phase 4: Frontend (P3) - 3-4 days

1. **Wallet input component**
2. **Import flow UI**
3. **Results display**

## Architecture Decision: One Account vs Many

### Current Implementation (Wrong for this feature)

```
Account {
  id: "uuid-1"
  name: "My Wallet"
  institutionId: "metamask-generic"
  metadata: {
    walletAddress: "0x..."
    chainIds: [1, 137, 10, 42161, ...] // All EVM chains
  }
}
```

### Required Implementation (Correct)

```
Account {
  id: "uuid-1"
  name: "Ethereum Wallet (0x...)"
  institutionId: "ethereum-wallet"
  metadata: {
    walletAddress: "0x..."
    chainId: 1
  }
}

Account {
  id: "uuid-2"
  name: "Polygon Wallet (0x...)"
  institutionId: "polygon-wallet"
  metadata: {
    walletAddress: "0x..."
    chainId: 137
  }
}
```

**Reasoning**:

- Each account represents holdings on ONE specific chain
- Aligns with user mental model
- Simplifies portfolio valuation (each account is one chain)
- Matches existing account/holdings data model
- Allows per-chain naming and organization

## Next Steps

**Immediate Actions**:

1. ✅ Confirm this analysis aligns with user requirements
2. Create database migration for chain-specific institutions
3. Implement `wallet.importWalletAddress` endpoint
4. Add token find-or-create service
5. Add frontend UI for wallet import

**Open Questions**:

1. Should we allow importing the same address multiple times?
2. How to handle duplicate accounts (same address + chain)?
3. Should holdings be updated or error on duplicate?
4. What's the default naming convention for auto-created accounts?
5. Should users be able to rename chains/accounts after import?
