# DeFiLlama Token Lookup Integration

## Overview

DeFiLlama has been integrated as a fallback token lookup provider alongside CoinGecko and Finnhub. This provides additional coverage for cryptocurrency tokens, especially those not available on CoinGecko.

## Integration Points

### 1. Token Validation by Contract Address

A new method `validateTokenByContractAddress()` has been added to `TokenValidationService` that allows validating tokens using their contract address and chain ID via DeFiLlama's API.

**Usage:**
```typescript
const result = await tokenValidationService.validateTokenByContractAddress(
  '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT contract
  1 // Ethereum mainnet
);

if (result.isValid) {
  console.log(`Token: ${result.metadata.symbol}`);
  console.log(`Name: ${result.metadata.name}`);
  console.log(`Provider: ${result.metadata.provider}`); // 'defillama'
}
```

**Supported Chains:**
- Ethereum (1)
- Optimism (10)
- BSC (56)
- Gnosis Chain (100)
- Polygon (137)
- Fantom (250)
- zkSync Era (324)
- Base (8453)
- Arbitrum (42161)
- Avalanche (43114)
- Linea (59144)
- Scroll (534352)

### 2. Pricing Fallback

DeFiLlama was already integrated as a pricing fallback in `PricingService`. When CoinGecko fails to provide a price for a token with a known contract address, the system automatically falls back to DeFiLlama.

**How it works:**
1. Token is assigned to CoinGecko based on type or metadata
2. CoinGecko request fails or returns empty response
3. System checks if token has `contractAddress` and `chainId` in metadata
4. If available, automatically fetches price from DeFiLlama
5. DeFiLlama result replaces the failed CoinGecko result

### 3. Provider Type Support

The `TokenProvider` type has been updated to include 'defillama':

**Shared Types (`packages/shared/src/token-validatiion.ts`):**
```typescript
export const TokenProviderSchema = z.enum(['finnhub', 'coingecko', 'defillama']);
```

**Router Support:**
- Token router accepts 'defillama' as a valid provider
- Frontend `TokenOption` interface includes 'defillama'

## Limitations

### Symbol-Based Search Not Supported

DeFiLlama does not provide a symbol-based search API like CoinGecko or Finnhub. It requires a contract address to look up tokens. This means:

- ❌ Cannot search DeFiLlama by symbol (e.g., "USDT")
- ✅ Can validate tokens when contract address is known
- ✅ Can fetch prices for tokens with contract addresses
- ✅ Works automatically during wallet imports

**Error Handling:**
When CoinGecko search fails, the system logs a warning indicating that DeFiLlama fallback requires a contract address:

```typescript
this.logger.warn(
  { symbol, status: response.status },
  'CoinGecko search failed - DeFiLlama fallback requires contract address'
);
```

## Use Cases

### 1. Wallet Import with Unknown Tokens

When importing a wallet:
1. Wallet router discovers ERC-20 tokens with contract addresses
2. Tokens are stored with `contractAddress` and `chainId` in metadata
3. On first portfolio view, pricing service tries CoinGecko
4. If CoinGecko doesn't have the token, DeFiLlama is used automatically
5. Token prices are cached for future use

### 2. Manual Token Addition

When a user knows the contract address:
```typescript
const result = await tokenValidationService.validateTokenByContractAddress(
  contractAddress,
  chainId
);

if (result.isValid) {
  // Create token in database with DeFiLlama metadata
  await createToken(result.metadata);
}
```

### 3. Price Discovery for DEX Tokens

Small DEX tokens often aren't on CoinGecko but are on DeFiLlama:
- Token imported from wallet with contract address
- CoinGecko returns empty/invalid price
- DeFiLlama provides accurate price from DEX aggregation
- Portfolio displays correct valuation

## API Reference

### `validateTokenByContractAddress(contractAddress: string, chainId: number)`

Validates a token using DeFiLlama's price API.

**Parameters:**
- `contractAddress` - The token's contract address (checksummed or lowercase)
- `chainId` - The chain ID (e.g., 1 for Ethereum)

**Returns:** `Promise<ValidationResult>`
```typescript
{
  isValid: boolean;
  metadata?: {
    symbol: string;
    name: string;
    type: 'Crypto';
    currency: 'USD';
    provider: 'defillama';
    providerMetadata: {
      contractAddress: string;
      chainId: number;
      chainName: string;
      defiLlamaData: {...};
      validatedAt: string;
    };
  };
  error?: string;
}
```

**Error Cases:**
- Chain not supported by DeFiLlama
- Token not found on DeFiLlama
- Low confidence score (< 0.8)
- Invalid or zero price
- Network errors

### DeFiLlama Response Format

```typescript
{
  coins: {
    "ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7": {
      decimals: 6,
      symbol: "USDT",
      price: 1.0,
      timestamp: 1234567890,
      confidence: 0.99
    }
  }
}
```

**Confidence Score:**
- Range: 0 to 1
- Minimum accepted: 0.8
- Higher = more reliable price data
- Based on liquidity and data source quality

## Configuration

### Rate Limiting

DeFiLlama rate limiter in `PricingService`:
```typescript
private readonly defiLlamaRateLimiter = new RateLimiter(5, 1000); // 5 calls/sec
```

### Provider Configuration

In `provider-config.ts`:
```typescript
defiLlama: {
  name: 'DeFiLlama',
  baseUrl: 'https://coins.llama.fi',
  rateLimit: 300, // 5 calls/sec = 300 calls/min
}
```

## Testing

### Manual Testing

Since no automated tests are required per project guidelines, manual testing can be done:

1. **Test Contract Address Validation:**
   ```bash
   # Start backend
   bun run dev:backend
   
   # Call the validation endpoint with a known token
   # e.g., USDT: 0xdac17f958d2ee523a2206206994597c13d831ec7
   ```

2. **Test Pricing Fallback:**
   - Import a wallet with tokens not on CoinGecko
   - View portfolio to trigger pricing
   - Check logs for "DeFiLlama fallback" messages
   - Verify token prices appear correctly

3. **Test Provider Selection:**
   - Search for tokens by symbol (uses CoinGecko/Finnhub)
   - Create token with contract address metadata
   - Verify DeFiLlama is used for pricing

## Future Enhancements

1. **CoinGecko Contract Lookup:**
   - Before falling back to DeFiLlama, try to find CoinGecko ID by contract address
   - Store `coingecko.id` in metadata for future use
   - Only use DeFiLlama if CoinGecko truly doesn't have the token

2. **Multi-Provider Price Comparison:**
   - Fetch prices from both CoinGecko and DeFiLlama
   - Compare and use the more recent/reliable one
   - Track quality metrics per provider

3. **Search Enhancement:**
   - Integrate with third-party contract lookup services
   - Allow users to paste contract addresses directly in search
   - Auto-detect and validate via DeFiLlama

4. **Additional Chains:**
   - Add more EVM chains as DeFiLlama adds support
   - Add non-EVM chains (Solana, Cosmos, etc.)

## Files Modified

1. **packages/shared/src/token-validatiion.ts**
   - Added 'defillama' to `TokenProviderSchema`

2. **apps/backend/src/application/services/TokenValidationService.ts**
   - Added `CHAIN_ID_TO_DEFILLAMA` mapping
   - Added `validateTokenByContractAddress()` method
   - Enhanced error logging in `validateCryptoToken()`
   - Updated error message to mention DeFiLlama

3. **apps/backend/src/presentation/routers/tokens.ts**
   - Updated provider enum to include 'defillama'
   - Updated `TokenOption` type to accept 'defillama'

4. **apps/frontendV2/src/components/selectors/TokenSearchableSelector.tsx**
   - Updated `TokenOption` interface to include 'defillama'

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Token Lookup Flow                         │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  User Search     │
                    │  (by symbol)     │
                    └──────────────────┘
                              │
                ┌─────────────┼─────────────┐
                ▼                           ▼
        ┌──────────────┐          ┌──────────────┐
        │  CoinGecko   │          │   Finnhub    │
        │   Search     │          │   Search     │
        └──────────────┘          └──────────────┘
                │
                ▼
        ┌──────────────┐
        │  Success?    │──Yes──> Return results
        └──────────────┘
                │
                No (CoinGecko down)
                │
                ▼
        ┌──────────────────────┐
        │ Has contract addr?   │
        └──────────────────────┘
                │
        ┌───────┴───────┐
        │               │
       Yes              No
        │               │
        ▼               ▼
┌──────────────┐  ┌─────────────┐
│  DeFiLlama   │  │ Return      │
│  Lookup      │  │ error       │
└──────────────┘  └─────────────┘
        │
        ▼
  Return results
```

## Related Documentation

- [DEX_PRICING_SOURCES.md](./DEX_PRICING_SOURCES.md) - Analysis of DeFiLlama vs other pricing sources
- [DEFILLAMA_INTEGRATION.md](./DEFILLAMA_INTEGRATION.md) - Original pricing integration docs
- [BACKEND_ARCHITECTURE.md](../ARCHITECTURE.md) - Overall backend architecture
