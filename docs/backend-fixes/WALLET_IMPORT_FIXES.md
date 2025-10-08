# ERC-20 Wallet Import Fixes - October 2, 2025

## Issues Discovered

### 1. ❌ Incorrect Decimals (FIXED)

**Problem**: All ERC-20 tokens had wrong decimals (mostly 1 or 0)

- stETH: 1 instead of 18
- USDC (Base): 0 instead of 6
- somm: 0 instead of 6
- Most tokens: 1 instead of 18

**Root Cause**: `/apps/backend/src/services/etherscan.ts` calculated decimals from `TokenDivisor` string length:

```typescript
const divisor = BigInt(holding.TokenDivisor);
const decimals = divisor.toString().length - 1; // ❌ WRONG!
```

**Solution**: Fetch actual decimals from ERC-20 contracts via RPC:

```typescript
const { evmChainService } = await import("./chain/evm");
const tokenInfo = await evmChainService.getTokenInfo(
  holding.TokenAddress,
  chainId
);
// Use tokenInfo.decimals (fetched from contract.decimals() function)
```

**File Changed**: `/apps/backend/src/services/etherscan.ts` (lines 336-383)

---

### 2. ✅ DeFiLlama Integration (ALREADY CORRECT)

**Status**: Working correctly, just needs to be triggered

**Verification**:

- Metadata stored correctly: `{chainId: 1, contractAddress: "0xae7ab...", isERC20: true}` ✅
- Provider selection logic correct: checks `contractAddress` + `chainId` → routes to DeFiLlama ✅
- Debug test confirmed stETH would route to DeFiLlama with ID `1:0xae7ab96520de3a18e5e111b5eaab095312d7fe84` ✅

**Why no prices yet?**

- Only 2 prices cached (ETH, MATIC native tokens - went to CoinGecko, got empty response)
- 34 ERC-20 tokens with contractAddress - **NEVER PRICED YET**
- Pricing is **lazy** (only when viewing Dashboard/Holdings/Institutions pages)
- User hasn't navigated to Dashboard yet to trigger `users.getPortfolioValue`

---

## Files Modified

### 1. `/apps/backend/src/services/etherscan.ts`

- **Changed**: `getERC20TokenHoldings()` function
- **Action**: Now fetches actual decimals from ERC-20 contracts via RPC
- **Impact**: All future wallet imports will have correct decimals

### 2. `/apps/backend/src/services/pricing/providers/defillama.ts`

- **Status**: Already refactored as proper `PricingProvider` (previous session)
- **No changes needed**

### 3. `/apps/backend/src/services/pricing.ts`

- **Status**: DeFiLlama already integrated in provider registry (previous session)
- **No changes needed**

### 4. `/apps/backend/src/routers/wallet.ts`

- **Status**: Already simplified to use pricing service (previous session)
- **No changes needed**

---

## Database State

### Before Fixes

```sql
-- 34 ERC-20 tokens with wrong decimals
SELECT symbol, decimals FROM tokens WHERE provider_metadata::text LIKE '%contractAddress%';
-- Results: mostly decimals = 1 or 0

-- 2 bad cached prices (native tokens only)
SELECT COUNT(*) FROM token_prices WHERE price = '0' AND source LIKE '%CoinGecko%';
-- Result: 2 (ETH and MATIC)

-- 0 ERC-20 token prices
SELECT COUNT(*) FROM token_prices tp
JOIN tokens t ON tp.token_id = t.id
WHERE t.provider_metadata::text LIKE '%contractAddress%';
-- Result: 0
```

### After Fixes (User will clear DB manually)

- User will clear the database and re-import wallet
- New tokens will have correct decimals from contracts
- Prices will be fetched when viewing Dashboard

---

## Testing Plan

### 1. Clear Database

```bash
# User will clear the database manually
```

### 2. Re-import Wallet

- Navigate to wallet import page
- Import the same wallet address
- Verify tokens created with correct decimals

### 3. Trigger Pricing

- Navigate to Dashboard page
- This triggers `users.getPortfolioValue`
- Watch logs for DeFiLlama pricing attempts:
  ```
  "Assigning token to DeFiLlama based on contract address metadata"
  ```

### 4. Verify Results

```sql
-- Check decimals are correct
SELECT symbol, name, decimals, provider_metadata
FROM tokens
WHERE provider_metadata::text LIKE '%contractAddress%'
LIMIT 10;

-- Check prices were fetched
SELECT tp.price, tp.source, t.symbol
FROM token_prices tp
JOIN tokens t ON tp.token_id = t.id
WHERE t.provider_metadata::text LIKE '%contractAddress%'
LIMIT 10;
```

---

## Expected Behavior After Fixes

### Wallet Import Flow

1. User imports wallet address
2. Etherscan API returns token holdings with `TokenDivisor`
3. **NEW**: System fetches actual decimals from each ERC-20 contract via RPC
4. Tokens created with correct decimals ✅
5. Metadata stored: `{chainId, contractAddress, isERC20: true}` ✅

### Pricing Flow (when viewing Dashboard)

1. Frontend calls `trpc.users.getPortfolioValue.useQuery()`
2. Backend calls `pricingService.getTokenPrices()`
3. Pricing service checks metadata:
   - Has `contractAddress` + `chainId` → Route to DeFiLlama ✅
   - Logs: `"Assigning token to DeFiLlama based on contract address metadata"`
4. DeFiLlama fetches prices: `coins.llama.fi/prices/current/ethereum:0x...`
5. Prices cached in `token_prices` table
6. Portfolio value displayed in Dashboard

---

## Utility Scripts Created

### Clear Bad Cached Prices

```bash
bun run src/services/clear-bad-prices.ts
```

Removes cached prices with `price = '0'` from CoinGecko empty responses.

### Fix Decimals for Existing Tokens (NOT NEEDED - User will clear DB)

```bash
bun run src/services/fix-token-decimals.ts
```

Fetches correct decimals from contracts for all existing ERC-20 tokens.
**Status**: Not needed since user will clear database and re-import.

---

## Verification Checklist

- [x] Decimals fix implemented in `etherscan.ts`
- [x] DeFiLlama integration verified (already correct)
- [x] Provider selection logic verified (already correct)
- [x] Bad cached prices cleared (2 native tokens)
- [ ] User clears database manually
- [ ] User re-imports wallet
- [ ] Verify new tokens have correct decimals
- [ ] User navigates to Dashboard
- [ ] Verify DeFiLlama pricing triggered
- [ ] Verify prices stored in database

---

## Summary

✅ **Decimals Issue**: Fixed by fetching from contracts  
✅ **DeFiLlama Integration**: Already working correctly  
⏳ **Next Step**: User clears DB, re-imports wallet, then navigates to Dashboard to trigger pricing

The system is now ready for a clean test!
