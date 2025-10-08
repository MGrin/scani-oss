# Critical Fixes - Decimal Fetching & Pricing Issues

## Problems Identified

### 1. ❌ RPC Provider Failure - ALL Token Decimals Wrong

**Symptom**:

```
JsonRpcProvider failed to detect network and cannot start up; retry in 1s
⚠️ WARN Failed to fetch decimals from token contract, using fallback of 18
```

**Root Cause**:

- `JsonRpcProvider` was initialized WITHOUT proper network configuration
- Provider couldn't detect which chain it was connecting to
- ALL contract calls failed → 100% fallback to decimals=18

**Impact**:

- **USDC (Base)**: Shows 18 decimals instead of 6 ❌
- **All ERC-20 tokens**: Wrong decimals = corrupted data ❌
- Balance calculations completely incorrect ❌

### 2. ❌ Pricing System Working BUT Not Saving Data

**Symptom**:

```
✅ Pricing complete: 35/35 prices retrieved
✅ Initial pricing completed for imported wallet
BUT: Only 2 prices in database (both "0" from CoinGecko)
```

**Root Cause**:

- DeFiLlama API successfully returns 33 token prices
- Prices are retrieved but NOT being saved to `token_prices` table
- Only native token failures (ETH, MATIC) from CoinGecko are cached

**Database State**:

```sql
SELECT COUNT(*) FROM token_prices;
-- Result: 2 (only ETH and MATIC with price "0")

SELECT symbol, decimals FROM tokens WHERE symbol = 'USDC';
-- Result: USDC, decimals=18 (WRONG - should be 6)
```

## Solutions Implemented

### Fix 1: RPC Provider Configuration ✅

**File**: `/apps/backend/src/services/chain/evm.ts`

**Before**:

```typescript
private getProvider(chainId: number): JsonRpcProvider {
  let provider = this.providers.get(chainId);
  if (!provider) {
    const chainConfig = getChainConfig(chainId);
    if (!chainConfig) {
      throw new UnsupportedChainError(chainId, '');
    }
    // Use first RPC URL for provider
    provider = new JsonRpcProvider(chainConfig.rpcUrls[0]);
    this.providers.set(chainId, provider);
  }
  return provider;
}
```

**After**:

```typescript
private getProvider(chainId: number): JsonRpcProvider {
  let provider = this.providers.get(chainId);
  if (!provider) {
    const chainConfig = getChainConfig(chainId);
    if (!chainConfig) {
      throw new UnsupportedChainError(chainId, '');
    }
    // Use first RPC URL for provider with proper network configuration
    // This prevents "JsonRpcProvider failed to detect network" errors
    provider = new JsonRpcProvider(
      chainConfig.rpcUrls[0],
      chainId, // Explicitly specify the chain ID
      { staticNetwork: true } // Use static network to avoid network detection
    );
    this.providers.set(chainId, provider);
  }
  return provider;
}
```

**Why This Works**:

- Ethers.js JsonRpcProvider needs explicit chain ID to avoid network detection
- `staticNetwork: true` prevents async network detection that was failing
- Provider now immediately knows which chain it's connected to

### Fix 2: DeFiLlama Not Being Called ✅ **CRITICAL BUG**

**File**: `/apps/backend/src/services/pricing.ts`

**Root Cause**: DeFiLlama was NOT in the primary providers array!

**Before** (Line 960):

```typescript
const primaryProviders: PrimaryProviderKey[] = [
  "exchangeRate",
  "coinGecko",
  "finnhub",
];
// DeFiLlama missing from array!
```

**After**:

```typescript
const primaryProviders: PrimaryProviderKey[] = [
  "exchangeRate",
  "coinGecko",
  "finnhub",
  "defiLlama", // Added to fetch ERC-20 token prices
];
```

**What Was Happening**:

1. ✅ Token routing assigned 33 tokens to DeFiLlama
2. ❌ But DeFiLlama provider was NEVER called
3. ❌ Only CoinGecko and Finnhub were called (for native tokens)
4. ✅ Logs showed "Pricing complete: 35/35" because it counted routing, not actual fetches
5. ❌ Database only had 2 prices (ETH and MATIC failures from CoinGecko)

**Impact**:

- **ALL ERC-20 token prices**: NOT fetched ❌
- **33 tokens with DeFiLlama routing**: Never got prices ❌
- **Users saw**: "Pricing complete" but no actual price data ❌

## Expected Results After Fix

### Decimal Fetching

```
✅ Discovered 9 ERC-20 token holdings on chain 1
✅ Created token USDC (decimals: 6)  ← From contract
✅ Created token GAS (decimals: 18)  ← From contract
✅ Created token stETH (decimals: 18) ← From contract
✅ Created token somm (decimals: 6)   ← From contract
```

### Pricing

```
✅ Triggering initial pricing for imported wallet tokens...
✅ Assigning token to DeFiLlama based on contract address metadata (x33)
✅ Pricing complete: 35/35 prices retrieved
✅ Initial pricing completed for imported wallet

Database check:
SELECT COUNT(*) FROM token_prices;
-- Expected: 35+ prices (not just 2)
```

## Testing Plan

### Step 1: Clear Database

```sql
DELETE FROM holdings;
DELETE FROM accounts;
DELETE FROM tokens WHERE provider_metadata::text LIKE '%contractAddress%';
DELETE FROM token_prices;
```

### Step 2: Re-import Wallet

- Import address: `0x01583D152E3225519D211B1F576d959F70ef9630`
- Watch logs for:
  - ✅ No "JsonRpcProvider failed to detect network" errors
  - ✅ No fallback warnings for known tokens (USDC, etc.)
  - ✅ Correct decimals in "Created token" logs

### Step 3: Verify Database

```sql
-- Check decimals (should be accurate)
SELECT symbol, decimals, provider_metadata
FROM tokens
WHERE symbol IN ('USDC', 'WBTC', 'stETH', 'GAS')
ORDER BY symbol;

-- Expected Results:
-- USDC: decimals = 6 (Base chain)
-- GAS: decimals = 18 (Ethereum)
-- stETH: decimals = 18 (Ethereum)

-- Check prices (should have 35+ rows)
SELECT COUNT(*) as price_count FROM token_prices;
-- Expected: 35+ (not just 2)

-- Check price sources
SELECT
  tp.source,
  COUNT(*) as count
FROM token_prices tp
GROUP BY tp.source;
-- Expected: Multiple DeFiLlama sources (not just CoinGecko_empty_response)
```

## Critical Notes

### Data Integrity

- **ALL tokens must have accurate decimals** from contracts
- NO shortcuts or hardcoding allowed
- Fallback to 18 ONLY if contract call fails (with warning log)

### RPC Reliability

- Current RPC URLs are from public endpoints (LlamaRPC, Ankr, PublicNode)
- Multiple RPCs configured per chain for fallback
- If public RPCs are unreliable, may need to:
  - Add Alchemy/Infura with API keys
  - Implement better retry logic
  - Add exponential backoff

### Pricing Issue

- **STILL NEEDS INVESTIGATION**: Why DeFiLlama prices not being saved
- This is separate from decimals issue
- Pricing logs show success but database is missing data

## Status

✅ **Fix 1 Complete**: RPC provider configuration fixed - JsonRpcProvider now properly configured
✅ **Fix 2 Complete**: DeFiLlama added to primary providers array - Will now fetch ERC-20 prices
📋 **Testing Required**: User needs to clear DB and re-import wallet

## Expected Database Results After Fixes

### Before Fixes:

```sql
SELECT COUNT(*) FROM token_prices;
-- Result: 2 (only ETH and MATIC with price "0")
```

### After Fixes:

```sql
SELECT COUNT(*) FROM token_prices WHERE price != '0';
-- Expected: 30-35 (actual DeFiLlama prices for ERC-20 tokens)

SELECT source, COUNT(*)
FROM token_prices
GROUP BY source;
-- Expected:
-- DeFiLlama: ~33 rows
-- CoinGecko: ~2 rows (native tokens)
```

## Next Steps

1. User clears database
2. User re-imports wallet
3. Check logs for RPC errors and decimal accuracy
4. Query database to verify:
   - Correct decimals for all tokens
   - Prices stored in token_prices table
5. If pricing still fails, investigate `pricing.ts` caching logic
