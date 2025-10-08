# 🔍 Research: Token Balance APIs & Alternatives

**Date:** October 2, 2025  
**Purpose:** Evaluate different approaches for fetching ERC-20 token balances

---

## 🎯 Key Requirements

1. **Token Balance Fetching** - Get balance for any ERC-20 token by contract address
2. **Token Metadata** - Name, symbol, decimals for each token
3. **Multi-Token Support** - Fetch multiple tokens efficiently
4. **CoinGecko Validation** - Only track tokens listed on CoinGecko (for pricing)
5. **Rate Limiting** - Must respect API limits
6. **Cost** - Prefer free or low-cost solutions

---

## 📊 Option 1: CoinGecko API ✅ RECOMMENDED

### What CoinGecko Provides

**Endpoint:** `/coins/{platform}/contract/{contract_address}`

**Example:**

```
GET /coins/ethereum/contract/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
```

**Returns:**

- ✅ Token metadata (name, symbol, decimals)
- ✅ Current price in USD
- ✅ Market data
- ✅ CoinGecko ID (for validation)
- ✅ Multi-chain support (Ethereum, Polygon, BSC, etc.)
- ✅ Platform-specific decimal places

**Platforms Supported:**

- `ethereum`, `polygon-pos`, `binance-smart-chain`, `arbitrum-one`, `optimistic-ethereum`
- `avalanche`, `fantom`, `solana`, `tron`, `base`, etc.

### What CoinGecko DOESN'T Provide

- ❌ Wallet balance (how much a user owns)
- ❌ Token discovery (list all tokens in wallet)
- ❌ Batch balance queries

### Rate Limits

- **Free API:** 10-30 calls/minute
- **Pro API:** Higher limits (we have API key)

### Pros

- ✅ Automatically validates token is on CoinGecko
- ✅ Gets token metadata + price in one call
- ✅ We already use it for pricing
- ✅ Multi-chain support
- ✅ Free tier available

### Cons

- ❌ Doesn't return wallet balances
- ❌ Need separate RPC calls for balance
- ❌ Rate limited

---

## 📊 Option 2: Direct RPC Calls (ethers.js) ✅ RECOMMENDED

### How It Works

Use standard JSON-RPC calls to blockchain nodes:

```typescript
// ERC-20 balanceOf call
const contract = new Contract(tokenAddress, ERC20_ABI, provider);
const balance = await contract.balanceOf(walletAddress);
const decimals = await contract.decimals();
const symbol = await contract.symbol();
```

### RPC Providers (Free Tier)

1. **Infura** - 100k requests/day (free)
2. **Alchemy** - 300 million compute units/month (free)
3. **QuickNode** - Free tier available
4. **Public RPCs** - Free but unreliable

### Pros

- ✅ Direct blockchain queries (no middleman)
- ✅ Works for ANY token (not just CoinGecko)
- ✅ Free with generous limits
- ✅ We control the logic
- ✅ Can batch with Multicall

### Cons

- ❌ No automatic CoinGecko validation
- ❌ Need to query each chain separately
- ❌ Need to handle RPC failures
- ❌ Slower than dedicated APIs

---

## 📊 Option 3: Blockchain APIs (Etherscan, etc.) 🟡 ALTERNATIVE

### Services

1. **Etherscan API** - Free tier: 5 calls/second
2. **Polygonscan API** - Same as Etherscan
3. **BSCScan API** - Same as Etherscan
4. **Blockscout** - Open source, self-hostable

### Endpoint Example (Etherscan)

```
GET https://api.etherscan.io/api
?module=account
&action=tokenbalance
&contractaddress=0x...
&address=0x...
&tag=latest
&apikey=...
```

### Pros

- ✅ Direct token balance queries
- ✅ Historical data available
- ✅ Free tier available
- ✅ Chain-specific explorers

### Cons

- ❌ Separate API key per chain
- ❌ Rate limits (5 calls/sec)
- ❌ Not all chains have explorers
- ❌ No CoinGecko validation

---

## 📊 Option 4: Wallet APIs (Moralis, Alchemy, etc.) 💰 PAID

### Services

1. **Moralis** - $49/month for 3M compute units
2. **Alchemy Enhanced APIs** - Paid tier
3. **Covalent** - $0.25 per 1000 credits
4. **Ankr** - Free tier limited

### Features

- ✅ Get all tokens in wallet (single call)
- ✅ Token metadata included
- ✅ Multi-chain support
- ✅ Token discovery
- ✅ Historical balances
- ✅ NFT support

### Example (Moralis)

```
GET https://deep-index.moralis.io/api/v2/{address}/erc20
```

Returns all ERC-20 tokens for address.

### Pros

- ✅ Single API call for all tokens
- ✅ Token discovery (no need to know addresses)
- ✅ Multi-chain support
- ✅ Professional support
- ✅ Battle-tested

### Cons

- ❌ **COSTS MONEY** ($49/month minimum)
- ❌ Still need CoinGecko for validation
- ❌ Vendor lock-in
- ❌ Overkill for our use case

---

## 📊 Option 5: The Graph Protocol 🟡 ADVANCED

### How It Works

Query decentralized subgraphs for token data:

```graphql
{
  tokenBalances(where: { account: "0x..." }) {
    token {
      id
      symbol
      name
      decimals
    }
    balance
  }
}
```

### Pros

- ✅ Decentralized
- ✅ GraphQL queries
- ✅ Custom data indexing
- ✅ Free hosted service

### Cons

- ❌ Requires subgraph setup
- ❌ Not all tokens indexed
- ❌ Complex to implement
- ❌ Slower than direct APIs

---

## 🎯 RECOMMENDED APPROACH

### Hybrid Solution: CoinGecko + RPC Calls

**Step 1: Token Discovery & Validation (CoinGecko)**

1. Maintain a curated list of popular tokens per chain
2. For each token, query CoinGecko to get:
   - Token metadata (name, symbol, decimals)
   - CoinGecko ID (for validation)
   - Current price
   - Confirms token is listed

**Step 2: Balance Fetching (Direct RPC)**

1. Use ethers.js to query token balance
2. Use free RPC providers (Infura, Alchemy)
3. Batch requests with Multicall3 (optimization)

**Step 3: Filter by CoinGecko**

1. Only show tokens that have CoinGecko IDs
2. Ignore random/scam tokens
3. Ensures we can price everything

### Why This Works

1. ✅ **Cost:** Completely free (using free tiers)
2. ✅ **Validation:** Only CoinGecko tokens shown
3. ✅ **Pricing:** CoinGecko already integrated
4. ✅ **Balance:** Direct blockchain queries
5. ✅ **Control:** We own the logic
6. ✅ **Scalable:** Can add more chains easily

### Implementation Plan

```typescript
// 1. Curated token list (popular-tokens.ts)
interface PopularToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chainId: number;
  coingeckoId: string; // CRITICAL: Pre-validated
}

// 2. Token balance service
class TokenBalanceService {
  async getTokenBalance(
    walletAddress: string,
    tokenAddress: string,
    chainId: number
  ): Promise<TokenBalance> {
    // Query blockchain for balance
    const contract = new Contract(tokenAddress, ERC20_ABI, provider);
    const balance = await contract.balanceOf(walletAddress);

    // Get metadata from our curated list or blockchain
    const metadata = await this.getTokenMetadata(tokenAddress, chainId);

    // Validate against CoinGecko
    if (!metadata.coingeckoId) {
      throw new Error("Token not listed on CoinGecko");
    }

    return { balance, metadata };
  }

  async getPopularTokenBalances(
    walletAddress: string,
    chainId: number
  ): Promise<TokenBalance[]> {
    const popularTokens = getPopularTokensForChain(chainId);

    // Batch fetch with Multicall (future optimization)
    const balances = await Promise.all(
      popularTokens.map((token) =>
        this.getTokenBalance(walletAddress, token.address, chainId)
      )
    );

    // Filter out zero balances
    return balances.filter((b) => b.balance.gt(0));
  }
}
```

---

## 💰 Cost Comparison

| Solution                     | Monthly Cost   | Setup Time | Maintenance |
| ---------------------------- | -------------- | ---------- | ----------- |
| **Hybrid (CoinGecko + RPC)** | $0             | 1 day      | Low         |
| Direct RPC Only              | $0             | 1 day      | Medium      |
| Etherscan APIs               | $0 (free tier) | 2 days     | Medium      |
| Moralis                      | $49-199        | 2 hours    | Low         |
| Alchemy Enhanced             | $49+           | 2 hours    | Low         |
| The Graph                    | $0             | 3-5 days   | High        |

---

## 🎯 Decision: Hybrid Approach

### Implementation Steps

1. ✅ **Day 1:** Create popular tokens list (20-30 tokens per chain)
2. ✅ **Day 1:** Implement RPC balance fetching with ethers.js
3. ✅ **Day 1:** Validate all tokens have CoinGecko IDs
4. ✅ **Day 2:** Add TRC-20, SPL token support
5. ✅ **Day 3:** Frontend UI
6. 🔮 **Future:** Multicall3 batch optimization
7. 🔮 **Future:** User custom token addition (with CoinGecko validation)

### Popular Tokens to Support (Priority)

**Ethereum:**

1. USDT - 0xdAC17F958D2ee523a2206206994597C13D831ec7
2. USDC - 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
3. LINK - 0x514910771AF9Ca656af840dff83E8264EcF986CA
4. UNI - 0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984
5. WBTC - 0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599
6. DAI - 0x6B175474E89094C44Da98b954EedeAC495271d0F
7. AAVE - 0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9
8. MKR - 0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2
9. SHIB - 0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE
10. PEPE - 0x6982508145454Ce325dDbE47a25d4ec3d2311933

**Polygon, BSC, Arbitrum:** Similar top tokens

**Total:** ~30 tokens per chain, 4-5 chains = 120-150 tokens

---

## ✅ Conclusion

**Use Hybrid Approach:**

1. CoinGecko for token validation & metadata
2. Direct RPC (ethers.js) for balance fetching
3. Curated list of popular tokens
4. Free, scalable, and we control the logic

**Next Steps:**

1. Create popular-tokens.ts with top 30 tokens per chain
2. Implement RPC balance fetching
3. Validate all tokens against CoinGecko
4. Build tRPC endpoints

---

**Research Completed:** October 2, 2025  
**Decision:** Hybrid (CoinGecko + RPC)  
**Cost:** $0/month  
**Timeline:** 2-3 days for full implementation
