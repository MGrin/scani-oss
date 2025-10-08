# ✅ Revised Approach: Hybrid Solution

**Date:** October 2, 2025  
**Decision:** Use CoinGecko + Direct RPC Calls

---

## 🎯 Your Key Insights

You asked two critical questions that changed the approach:

1. **"Are there any existing free APIs to get this data?"**

   - Answer: Yes! But they either cost money (Moralis, Alchemy) or don't provide everything we need

2. **"Can CoinGecko API help us with this task?"**
   - Answer: YES! CoinGecko can validate tokens AND provide metadata
   - Bonus: We MUST use CoinGecko anyway (for pricing)

---

## 💡 The Hybrid Approach

### Component 1: CoinGecko for Validation & Metadata ✅

**What CoinGecko Provides:**

```
GET /coins/{platform}/contract/{contract_address}
```

**Example Response:**

```json
{
  "id": "usd-coin",
  "symbol": "usdc",
  "name": "USDC",
  "detail_platforms": {
    "ethereum": {
      "decimal_place": 6,
      "contract_address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
    }
  },
  "market_data": {
    "current_price": { "usd": 1.003 }
  }
}
```

**Benefits:**

- ✅ Validates token is real (listed on CoinGecko)
- ✅ Gets token metadata (name, symbol, decimals)
- ✅ Gets current price (bonus!)
- ✅ Multi-chain support
- ✅ We already use CoinGecko for pricing

**Your Requirement:** "We don't need any token that is not listed on CoinGecko"

- ✅ **PERFECT!** This automatically filters out scam/fake tokens

### Component 2: Direct RPC for Balances ✅

**What RPC Provides:**

```typescript
// Using ethers.js
const contract = new Contract(tokenAddress, ERC20_ABI, provider);
const balance = await contract.balanceOf(walletAddress);
```

**Benefits:**

- ✅ Free (Infura, Alchemy free tiers)
- ✅ Direct blockchain queries
- ✅ Works for any token
- ✅ No vendor lock-in

---

## 🔄 Complete Flow

### User Imports Wallet

```
1. User enters wallet address: 0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
2. System detects: EVM address

3. For each chain (Ethereum, Polygon, BSC):

   a) Get popular tokens list for chain
      → USDT, USDC, WETH, LINK, etc. (pre-curated with CoinGecko IDs)

   b) For each token:
      i.   Query blockchain (RPC): Get balance
      ii.  Query CoinGecko: Get metadata + price
      iii. Validate: Has CoinGecko ID? ✅ Keep it : ❌ Ignore it

   c) Filter: Only show tokens with balance > 0

4. Create holdings in database
5. Show user their portfolio
```

### Why This Works

1. **Only CoinGecko Tokens** ✅

   - Pre-curated list only includes tokens with CoinGecko IDs
   - Custom tokens must be validated against CoinGecko first
   - Automatic filtering of scam tokens

2. **Free & Scalable** ✅

   - CoinGecko: Free tier (10-30 calls/min)
   - RPC calls: Free tier (100k/day with Infura)
   - Total cost: $0

3. **Single Source of Truth** ✅

   - CoinGecko for: Validation, metadata, pricing
   - Blockchain for: Actual balance
   - No conflicts

4. **Future-Proof** ✅
   - Easy to add new chains
   - Easy to add new tokens
   - We control the logic

---

## 📝 Implementation Details

### Popular Tokens List

```typescript
// apps/backend/src/config/popular-tokens.ts
interface PopularToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chainId: number;
  coingeckoId: string; // ← CRITICAL: Pre-validated
  coingeckoPlatform: string; // ethereum, polygon-pos, etc.
}

export const POPULAR_TOKENS: PopularToken[] = [
  // Ethereum
  {
    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    chainId: 1,
    coingeckoId: "tether",
    coingeckoPlatform: "ethereum",
  },
  // ... 29 more for Ethereum
  // ... 30 for Polygon
  // ... 30 for BSC
  // ... etc
];
```

### Token Balance Service

```typescript
// apps/backend/src/services/chain/evm-tokens.ts
class EVMTokenService {
  async getTokenBalance(
    walletAddress: string,
    token: PopularToken
  ): Promise<TokenBalance> {
    // 1. Get balance from blockchain (RPC)
    const contract = new Contract(token.address, ERC20_ABI, provider);
    const rawBalance = await contract.balanceOf(walletAddress);

    // 2. Convert with decimals
    const balance = new Decimal(rawBalance.toString()).div(
      new Decimal(10).pow(token.decimals)
    );

    // 3. Get current price from CoinGecko (cached)
    const price = await this.coinGeckoService.getPrice(token.coingeckoId);

    return {
      ...token,
      balance,
      price,
      value: balance.mul(price),
    };
  }

  async getPopularTokenBalances(
    walletAddress: string,
    chainId: number
  ): Promise<TokenBalance[]> {
    // Get pre-curated list for chain
    const popularTokens = POPULAR_TOKENS.filter((t) => t.chainId === chainId);

    // Fetch balances (sequential for now, parallel later)
    const balances = await Promise.all(
      popularTokens.map((token) => this.getTokenBalance(walletAddress, token))
    );

    // Only return non-zero balances
    return balances.filter((b) => b.balance.gt(0));
  }
}
```

### CoinGecko Validation (for Custom Tokens)

```typescript
// User wants to add custom token
async validateCustomToken(
  chainId: number,
  tokenAddress: string
): Promise<PopularToken | null> {
  // 1. Get CoinGecko platform ID
  const platform = this.getCoinGeckoPlatform(chainId); // ethereum, polygon-pos, etc.

  // 2. Query CoinGecko
  const url = `${COINGECKO_BASE}/coins/${platform}/contract/${tokenAddress}`;
  const response = await fetch(url);

  if (!response.ok) {
    // Token not on CoinGecko = reject
    return null;
  }

  const data = await response.json();

  // 3. Extract metadata
  return {
    address: tokenAddress,
    symbol: data.symbol.toUpperCase(),
    name: data.name,
    decimals: data.detail_platforms[platform].decimal_place,
    chainId,
    coingeckoId: data.id,
    coingeckoPlatform: platform,
  };
}
```

---

## 🎯 Benefits of This Approach

### 1. Automatic Scam Filtering ✅

**Your Requirement:** "Don't need any token that is not listed on CoinGecko"

- ✅ Pre-curated list only has CoinGecko tokens
- ✅ Custom tokens validated against CoinGecko
- ✅ Scam/fake tokens automatically rejected
- ✅ Users only see legitimate tokens

### 2. Single Source for Pricing ✅

- ✅ CoinGecko for ALL pricing (consistency)
- ✅ No need for multiple pricing APIs
- ✅ Already integrated and working

### 3. Cost-Effective ✅

- ✅ Completely free (using free tiers)
- ✅ CoinGecko: 10-30 calls/min (enough for us)
- ✅ RPC: 100k calls/day (way more than needed)
- ✅ No monthly fees

### 4. Future-Proof ✅

- ✅ Easy to add new chains
- ✅ Easy to add new tokens
- ✅ Can optimize with Multicall later
- ✅ Can add more RPC providers for redundancy

---

## 📊 Rate Limiting Strategy

### CoinGecko API

**Current Setup:** 10 calls/minute (free tier)

**Usage Pattern:**

- Token validation: 1 call per custom token
- Price fetching: Batched (already implemented)
- Metadata: Cached after first fetch

**Optimization:**

- Cache token metadata for 24 hours
- Batch price queries (already done)
- Use popular tokens list (pre-validated)

### RPC Calls

**Providers:**

- Infura: 100k requests/day (free)
- Alchemy: 300M compute units/month (free)
- Public RPCs: Unlimited but unreliable

**Usage Pattern:**

- Balance query: 1 call per token
- 30 tokens × 3 chains × 100 users/day = 9,000 calls/day
- Well within free tier limits

---

## ✅ Decision Summary

**Approach:** Hybrid (CoinGecko + Direct RPC)

**Components:**

1. CoinGecko for validation, metadata, pricing
2. Direct RPC for balance fetching
3. Pre-curated list of popular tokens
4. Custom token validation via CoinGecko

**Benefits:**

- ✅ Only CoinGecko-listed tokens
- ✅ Automatic scam filtering
- ✅ Free and scalable
- ✅ Single pricing source
- ✅ We control the logic

**Cost:** $0/month

**Timeline:** 2-3 days for full implementation

---

**Thank you for the excellent questions!** This hybrid approach is much better than the original plan.

**Next:** Start implementing with curated popular tokens list.
