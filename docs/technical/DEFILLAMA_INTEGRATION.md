# DeFiLlama Integration - Pricing Provider Architecture

## Overview

DeFiLlama has been properly integrated as a **pricing provider** within the pricing service architecture, alongside CoinGecko, Finnhub, and ExchangeRate providers. This provides automatic fallback pricing for ERC-20 tokens that are not available on CoinGecko.

## Architecture

### 1. Provider Registration

DeFiLlama is registered as a standard pricing provider in `pricing.ts`:

```typescript
this.providers = {
  exchangeRate: new ExchangeRateProvider(...),
  coinGecko: new CoinGeckoProvider(...),
  defiLlama: new DeFiLlamaProvider(...),  // ← New provider
  finnhub: new FinnhubProvider(...),
}
```

### 2. Rate Limiting

DeFiLlama has its own dedicated rate limiter (5 calls/sec):

```typescript
private readonly defiLlamaRateLimiter = new RateLimiter(5, 1000);
```

### 3. Provider Selection Logic

The pricing service automatically selects the appropriate provider based on token metadata stored in the `tokens` table:

**Token Metadata Structure**:

```json
{
  "chainId": 1,
  "contractAddress": "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84",
  "isERC20": true
}
```

**Provider Selection Flow** (in `groupTokensByProvider()`):

1. **Check for explicit provider metadata**:

   - `metadata.finnhub?.symbol` → Use Finnhub
   - `metadata.coingecko?.id` → Use CoinGecko
   - `metadata.contractAddress` + `metadata.chainId` → **Use DeFiLlama**

2. **Fallback to type-based assignment**:
   - `crypto` token type → CoinGecko (primary)
   - If CoinGecko fails, token with contract address → DeFiLlama (fallback)

### 4. Token ID Format

DeFiLlama requires a specific token ID format in `getProviderTokenId()`:

```typescript
case "defiLlama": {
  const contractAddress = metadata.contractAddress as string | undefined;
  const chainId = metadata.chainId as number | undefined;
  if (contractAddress && chainId) {
    return `${chainId}:${contractAddress}`;  // e.g., "1:0xae7ab..."
  }
  return undefined;
}
```

## Wallet Import Flow

### Before (Problematic)

The wallet router manually called:

1. `pricingService.getCoinGeckoIdByContractAddress()` for each token
2. Direct `getTokenPriceFromDeFiLlama()` call if CoinGecko failed
3. Filtered out tokens without pricing **during import**

**Issues**:

- ❌ Bypassed pricing service architecture
- ❌ Separate rate limiters for CoinGecko ID lookup
- ❌ Manual provider selection logic
- ❌ Tokens without immediate pricing were discarded

### After (Correct Architecture)

The wallet router now:

1. Filters **spam tokens only** (URLs, scam keywords)
2. Stores **all valid tokens** with contract address metadata
3. Lets the **pricing service handle provider selection** automatically

```typescript
// Wallet import only does spam filtering
const validTokens = erc20Tokens
  .filter(token => !isLikelySpamToken(token))
  .map(token => ({
    ...token,
    balance: convertFromWei(token.balance, token.decimals)
  }));

// Store token with metadata
const tokenMetadata = {
  chainId: erc20Token.chainId,
  contractAddress: erc20Token.address,  // ← DeFiLlama will use this
  isERC20: true,
};

const tokenId = await findOrCreateToken(..., tokenMetadata);
```

**Benefits**:

- ✅ Clean separation of concerns
- ✅ Unified rate limiting through pricing service
- ✅ Automatic provider fallback (CoinGecko → DeFiLlama)
- ✅ Tokens available even if pricing fails temporarily
- ✅ Price cache system works for all providers

## Pricing Flow Example

**User imports wallet with stETH (Lido Staked ETH)**:

1. **Wallet Router**:

   ```
   - Discovers token: 0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84 (stETH)
   - Not spam → Store in database
   - Metadata: { chainId: 1, contractAddress: "0xae7ab..." }
   ```

2. **Pricing Service** (when portfolio is viewed):

   ```
   - groupTokensByProvider() detects contractAddress
   - Assigns to DeFiLlama provider
   - providerTokenId: "1:0xae7ab..."
   ```

3. **DeFiLlama Provider**:

   ```
   - Fetches: https://coins.llama.fi/prices/current/ethereum:0xae7ab...
   - Returns price: $3,450
   - Caches price in tokenPrices table
   ```

4. **Portfolio Display**:
   ```
   - Holdings show current value based on cached price
   - Price refreshes automatically per pricing service TTL
   ```

## Supported Chains

DeFiLlama supports 30+ EVM chains:

```typescript
const CHAIN_ID_TO_DEFILLAMA = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  137: "polygon",
  250: "fantom",
  324: "era", // zkSync Era
  8453: "base",
  42161: "arbitrum",
  43114: "avax",
  59144: "linea",
  534352: "scroll",
  // ... more chains
};
```

## Spam Token Filtering

The `isLikelySpamToken()` utility (exported from `defillama.ts`) filters tokens with:

- URLs in name/symbol (http://, www., .com, .xyz, etc.)
- Scam keywords (claim, visit, reward, bonus, airdrop)
- Telegram references (t.me, telegram)
- Special patterns (starts with $, "Swap on", "Claim on")

**This happens at import time**, before tokens are stored in the database.

## Configuration

### Rate Limits

- **CoinGecko**: 10 calls/min (conservative for public API)
- **DeFiLlama**: 5 calls/sec (300 calls/min)
- **Provider fallback**: Automatic, no configuration needed

### Confidence Threshold

DeFiLlama returns a confidence score (0-1). We only accept prices with confidence ≥ 0.8:

```typescript
if (tokenData.confidence < 0.8) {
  // Reject low confidence price
  return createFailureResult(...);
}
```

## Testing

To test DeFiLlama integration:

1. Import a wallet with tokens not on CoinGecko (e.g., small DEX tokens)
2. Check logs for `"Assigning token to DeFiLlama based on contract address metadata"`
3. View portfolio - tokens should show prices from DeFiLlama
4. Check `tokenPrices` table for source: `"DeFiLlama"`

## Future Enhancements

1. **CoinGecko ID Lookup**: Add CoinGecko contract lookup as Phase 2

   - Check CoinGecko first (more reliable)
   - Store `coingecko.id` in metadata if found
   - Use DeFiLlama only for tokens truly not on CoinGecko

2. **Multiple Providers**: Add 1inch, 0x for even better coverage

   - See `DEX_PRICING_SOURCES.md` for analysis

3. **Price Quality Metrics**: Track which provider gives best prices
   - Compare CoinGecko vs DeFiLlama for same token
   - Optimize provider selection based on historical accuracy

## Key Files

- `apps/backend/src/services/pricing/providers/defillama.ts` - DeFiLlama provider implementation
- `apps/backend/src/services/pricing.ts` - Provider registration and selection logic
- `apps/backend/src/services/pricing/provider-config.ts` - Provider configuration
- `apps/backend/src/services/pricing/types.ts` - Type definitions
- `apps/backend/src/routers/wallet.ts` - Wallet import with spam filtering
