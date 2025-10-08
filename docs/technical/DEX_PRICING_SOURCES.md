# Alternative Pricing Sources for Tokens Not on CoinGecko

## Problem

Many ERC-20 tokens are not listed on CoinGecko, especially:

- **New/small tokens** - Recently launched or low market cap
- **DEX-only tokens** - Never listed on centralized exchanges
- **Spam tokens** - Airdropped scam tokens (should be filtered out)
- **Wrapped/derivative tokens** - stETH, wstETH, etc. (may have different IDs)

## Solution: DEX Aggregator Price Feeds

Instead of relying solely on CoinGecko, we can query decentralized exchange (DEX) aggregators that have real-time pricing for ANY token with liquidity.

---

## Recommended DEX Pricing Sources

### 1. **1inch API** (Best Option)

- **Website**: https://1inch.io
- **API Docs**: https://docs.1inch.io/docs/aggregation-protocol/api/swagger
- **Endpoint**: `GET /v5.2/{chainId}/quote`
- **Chains Supported**: 30+ (Ethereum, Polygon, Arbitrum, Optimism, Base, BSC, etc.)
- **Rate Limit**: Free tier: 1 req/sec
- **Pricing**: Free (no API key required for read operations)

**Example Request**:

```bash
https://api.1inch.dev/swap/v5.2/1/quote
  ?src=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE  # ETH
  &dst=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48  # USDC
  &amount=1000000000000000000                      # 1 ETH in wei
```

**Response**:

```json
{
  "toAmount": "2350000000",  // 2,350 USDC (6 decimals)
  "protocols": [...],
  "gas": "150000"
}
```

**Advantages**:

- ✅ Covers ALL tokens with ANY liquidity
- ✅ Multi-chain support (30+ chains)
- ✅ Aggregates best price across all DEXes
- ✅ Free tier available
- ✅ No API key required

**Disadvantages**:

- ⚠️ Requires converting to USD via stablecoin (add extra call)
- ⚠️ Rate limits on free tier

---

### 2. **0x API** (Alternative)

- **Website**: https://0x.org
- **API Docs**: https://0x.org/docs/api
- **Endpoint**: `GET /swap/v1/price`
- **Chains Supported**: Ethereum, Polygon, BSC, Arbitrum, Optimism, Base, Avalanche
- **Rate Limit**: Free tier: 10 req/sec
- **Pricing**: Free (API key required)

**Example Request**:

```bash
https://api.0x.org/swap/v1/price
  ?sellToken=ETH
  &buyToken=USDC
  &sellAmount=1000000000000000000
```

**Response**:

```json
{
  "price": "2350.50",
  "buyAmount": "2350500000",
  "sources": [...]
}
```

**Advantages**:

- ✅ Higher rate limits (10 req/sec)
- ✅ Cleaner API responses
- ✅ Multi-chain support

**Disadvantages**:

- ⚠️ Requires API key registration
- ⚠️ Slightly fewer chains than 1inch

---

### 3. **Uniswap Subgraph** (On-Chain Data)

- **Website**: https://thegraph.com/hosted-service
- **Endpoint**: GraphQL query to Uniswap V3 subgraph
- **Chains Supported**: Ethereum, Polygon, Arbitrum, Optimism, Celo
- **Rate Limit**: Free tier: 1000 queries/day
- **Pricing**: Free

**Example GraphQL Query**:

```graphql
{
  token(id: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48") {
    symbol
    name
    decimals
    derivedETH
    totalLiquidity
    volumeUSD
  }
  bundle(id: "1") {
    ethPriceUSD
  }
}
```

**Advantages**:

- ✅ True on-chain data
- ✅ Historical price data available
- ✅ Free

**Disadvantages**:

- ⚠️ More complex (GraphQL)
- ⚠️ Needs separate queries for each chain
- ⚠️ May be outdated (15min delay)

---

### 4. **DeFiLlama API** (Aggregated DEX Data)

- **Website**: https://defillama.com
- **API Docs**: https://defillama.com/docs/api
- **Endpoint**: `GET /coins/prices/current/{chain}:{tokenAddress}`
- **Chains Supported**: 100+ chains
- **Rate Limit**: No official limit (be respectful)
- **Pricing**: Free

**Example Request**:

```bash
https://coins.llama.fi/prices/current/ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
```

**Response**:

```json
{
  "coins": {
    "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": {
      "decimals": 6,
      "symbol": "USDC",
      "price": 1.0,
      "timestamp": 1704729600,
      "confidence": 0.99
    }
  }
}
```

**Advantages**:

- ✅ Simplest API (REST, no GraphQL)
- ✅ Massive chain coverage (100+)
- ✅ Aggregates multiple sources (DEXes + CEXes)
- ✅ Free, no API key

**Disadvantages**:

- ⚠️ Community project (no SLA)
- ⚠️ May have rate limits if abused

---

## Recommended Implementation Strategy

### Phase 1: Add DeFiLlama as Fallback (EASY)

```typescript
// apps/backend/src/services/pricing/providers/defillama.ts

export async function getTokenPriceFromDeFiLlama(
  tokenAddress: string,
  chainId: number
): Promise<number | undefined> {
  const chainName = CHAIN_ID_TO_DEFILLAMA_NAME[chainId];
  if (!chainName) return undefined;

  const url = `https://coins.llama.fi/prices/current/${chainName}:${tokenAddress}`;
  const response = await fetch(url);
  const data = await response.json();

  const key = `${chainName}:${tokenAddress.toLowerCase()}`;
  return data.coins?.[key]?.price;
}
```

**Integration Point**:
In `wallet.ts`, after checking CoinGecko:

```typescript
let coingeckoId = await pricingService.getCoinGeckoIdByContractAddress(
  token.address,
  chainId
);

// Fallback to DeFiLlama if CoinGecko fails
if (!coingeckoId) {
  const price = await getTokenPriceFromDeFiLlama(token.address, chainId);
  if (price) {
    // Store token with DeFiLlama pricing source
    return { ...token, price, pricingSource: "defillama" };
  }
}
```

### Phase 2: Add 1inch for Real-Time DEX Quotes (MEDIUM)

Use 1inch API to get real-time swap quotes. Convert to USD via stablecoin.

```typescript
async function getTokenPriceFrom1inch(
  tokenAddress: string,
  chainId: number
): Promise<number | undefined> {
  // 1. Quote: Token -> USDC (get USD value)
  const usdcAddress = USDC_ADDRESSES[chainId];
  const amount = "1000000000000000000"; // 1 token (18 decimals)

  const url = `https://api.1inch.dev/swap/v5.2/${chainId}/quote`;
  const params = new URLSearchParams({
    src: tokenAddress,
    dst: usdcAddress,
    amount: amount,
  });

  const response = await fetch(`${url}?${params}`);
  const data = await response.json();

  // Convert toAmount (USDC with 6 decimals) to USD price per token
  const usdcAmount = Number(data.toAmount) / 1e6;
  const tokenAmount = Number(amount) / 1e18;
  return usdcAmount / tokenAmount;
}
```

### Phase 3: Smart Fallback Chain

1. **Try CoinGecko** (most reliable, centralized data)
2. **Try DeFiLlama** (aggregated DEX + CEX data)
3. **Try 1inch** (real-time DEX quotes)
4. **Skip token** (no pricing available)

---

## Handling Spam Tokens

Many tokens in the logs are spam (airdrop scams with names like "Visit steth.cc to claim").

**Filter Strategy**:

1. **Minimum Liquidity Check**: Only price tokens with > $10k liquidity
2. **Name Blacklist**: Skip tokens with suspicious names containing URLs
3. **Trust Score**: Use DeFiLlama's `confidence` score (> 0.8)

```typescript
function isSpamToken(token: { name: string; symbol: string }): boolean {
  const suspiciousPatterns = [
    /https?:\/\//i, // Contains URL
    /claim|visit|reward/i, // Scam keywords
    /^\$/, // Starts with $
    /\.com|\.xyz|\.cc/i, // Domain extensions
  ];

  return suspiciousPatterns.some(
    (pattern) => pattern.test(token.name) || pattern.test(token.symbol)
  );
}
```

---

## Summary

**Best Approach for Scani**:

1. ✅ **Keep CoinGecko as primary** (reliable, already integrated)
2. ✅ **Add DeFiLlama as fallback** (easy to implement, covers most tokens)
3. ✅ **Add spam token filtering** (block obvious scams)
4. 🔜 **Consider 1inch for Phase 2** (real-time DEX quotes if needed)

**Expected Results**:

- Before: 0/29 tokens priced (all skipped as "not on CoinGecko")
- After: ~5-10/29 tokens priced (legit tokens found via DeFiLlama)
- After spam filter: ~2-5/29 tokens priced (only real tokens imported)

This will dramatically improve wallet import success rate while avoiding spam token clutter! 🚀
