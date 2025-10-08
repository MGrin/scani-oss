# 🎯 October 3, 2025 - Action Plan

**Phase:** 1.5.1 - Crypto Wallet Integration (Day 3/7)  
**Focus:** ERC-20 Token Support Implementation  
**Goal:** Complete token balance fetching for Ethereum ecosystem

---

## 📋 Today's Objectives

### Primary Goal: ERC-20 Token Support ✨

Implement full ERC-20 token balance fetching for all EVM chains (Ethereum, Polygon, BSC, etc.)

**Success Criteria:**

- ✅ Fetch balances for any ERC-20 token by contract address
- ✅ Support multi-token balance fetching
- ✅ Token metadata fetching (name, symbol, decimals)
- ✅ Integration with existing EVM chain service
- ✅ Rate limiting for token API calls
- ✅ Unit tests for token functionality

---

## 🔧 Implementation Plan

### Step 1: Research & Design (30 min)

**Questions to Answer:**

1. What RPC methods do we need? (`eth_call`, `eth_getBalance`, etc.)
2. What's the ERC-20 ABI? (balanceOf, decimals, symbol, name)
3. How to batch token balance requests? (Multicall contract)
4. Which RPC providers support token calls? (Infura, Alchemy, etc.)
5. Rate limits for token queries?

**Resources:**

- ERC-20 standard: https://eips.ethereum.org/EIPS/eip-20
- Ethers.js documentation
- Viem documentation (modern alternative)
- Multicall3 contract: 0xcA11bde05977b3631167028862bE2a173976CA11

### Step 2: Update Base Types (15 min)

**File:** `apps/backend/src/services/chain/base.ts`

**Add:**

```typescript
export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface TokenBalance extends TokenInfo {
  balance: Decimal;
  chainId: number;
  chainName: string;
  walletAddress: string;
}

export interface ChainBalanceService {
  // ... existing methods ...

  // New token methods
  getTokenBalance?(
    walletAddress: string,
    tokenAddress: string,
    chainId: number
  ): Promise<TokenBalance>;

  getMultipleTokenBalances?(
    walletAddress: string,
    tokenAddresses: string[],
    chainId: number
  ): Promise<TokenBalance[]>;

  getTokenInfo?(tokenAddress: string, chainId: number): Promise<TokenInfo>;
}
```

### Step 3: ERC-20 Implementation (2-3 hours)

**File:** `apps/backend/src/services/chain/evm.ts`

**Add ERC-20 Methods:**

```typescript
import { Contract, JsonRpcProvider } from "ethers";

// ERC-20 ABI (minimal)
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];

class EVMChainService implements ChainBalanceService {
  // ... existing code ...

  async getTokenInfo(
    tokenAddress: string,
    chainId: number
  ): Promise<TokenInfo> {
    const chain = this.getChainConfig(chainId);
    const provider = new JsonRpcProvider(chain.rpcUrl);
    const contract = new Contract(tokenAddress, ERC20_ABI, provider);

    try {
      const [symbol, name, decimals] = await Promise.all([
        contract.symbol(),
        contract.name(),
        contract.decimals(),
      ]);

      return {
        address: tokenAddress,
        symbol,
        name,
        decimals: Number(decimals),
      };
    } catch (error) {
      throw new ChainServiceError(
        chainId,
        `Failed to fetch token info for ${tokenAddress}`,
        error
      );
    }
  }

  async getTokenBalance(
    walletAddress: string,
    tokenAddress: string,
    chainId: number
  ): Promise<TokenBalance> {
    const chain = this.getChainConfig(chainId);
    const provider = new JsonRpcProvider(chain.rpcUrl);
    const contract = new Contract(tokenAddress, ERC20_ABI, provider);

    try {
      // Fetch token info and balance in parallel
      const [tokenInfo, rawBalance] = await Promise.all([
        this.getTokenInfo(tokenAddress, chainId),
        contract.balanceOf(walletAddress),
      ]);

      // Convert to Decimal with proper decimals
      const balance = new Decimal(rawBalance.toString()).div(
        new Decimal(10).pow(tokenInfo.decimals)
      );

      return {
        ...tokenInfo,
        balance,
        chainId,
        chainName: chain.name,
        walletAddress,
      };
    } catch (error) {
      throw new ChainServiceError(
        chainId,
        `Failed to fetch token balance for ${tokenAddress}`,
        error
      );
    }
  }

  async getMultipleTokenBalances(
    walletAddress: string,
    tokenAddresses: string[],
    chainId: number
  ): Promise<TokenBalance[]> {
    // Option 1: Sequential (simple but slow)
    // const balances = await Promise.all(
    //   tokenAddresses.map(addr =>
    //     this.getTokenBalance(walletAddress, addr, chainId)
    //   )
    // );

    // Option 2: Multicall (efficient, preferred)
    // TODO: Implement Multicall3 integration

    // For now, use sequential with rate limiting
    const balances: TokenBalance[] = [];
    for (const tokenAddress of tokenAddresses) {
      try {
        const balance = await this.getTokenBalance(
          walletAddress,
          tokenAddress,
          chainId
        );
        balances.push(balance);
      } catch (error) {
        logger.error(
          `Failed to fetch balance for token ${tokenAddress}: ${error}`
        );
        // Continue with other tokens
      }
    }

    return balances;
  }
}
```

### Step 4: Add Popular Tokens List (30 min)

**File:** `apps/backend/src/config/popular-tokens.ts`

```typescript
export interface PopularToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  chainId: number;
  coingeckoId: string;
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
  },
  {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    chainId: 1,
    coingeckoId: "usd-coin",
  },
  {
    address: "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    symbol: "LINK",
    name: "Chainlink",
    decimals: 18,
    chainId: 1,
    coingeckoId: "chainlink",
  },
  // ... add more popular tokens (top 20-30)

  // Polygon
  {
    address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
    chainId: 137,
    coingeckoId: "tether",
  },
  // ... etc
];

export function getPopularTokensForChain(chainId: number): PopularToken[] {
  return POPULAR_TOKENS.filter((token) => token.chainId === chainId);
}
```

### Step 5: Update tRPC Router (1 hour)

**File:** `apps/backend/src/routers/wallet.ts`

**Add New Endpoints:**

```typescript
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { getPopularTokensForChain } from '../config/popular-tokens';

export const walletRouter = router({
  // ... existing endpoints ...

  // Get token balance for a specific token
  getTokenBalance: protectedProcedure
    .input(z.object({
      walletAddress: z.string(),
      tokenAddress: z.string(),
      chainId: z.number().int(),
    }))
    .query(async ({ input }) => {
      const service = multiChainService.getServiceForChain(input.chainId);

      if (!service.getTokenBalance) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Token balance not supported for this chain',
        });
      }

      return await service.getTokenBalance(
        input.walletAddress,
        input.tokenAddress,
        input.chainId
      );
    }),

  // Get balances for popular tokens
  getPopularTokenBalances: protectedProcedure
    .input(z.object({
      walletAddress: z.string(),
      chainId: z.number().int(),
    }))
    .query(async ({ input }) => {
      const service = multiChainService.getServiceForChain(input.chainId);

      if (!service.getMultipleTokenBalances) {
        return [];
      }

      const popularTokens = getPopularTokensForChain(input.chainId);
      const tokenAddresses = popularTokens.map(t => t.address);

      return await service.getMultipleTokenBalances(
        input.walletAddress,
        tokenAddresses,
        input.chainId
      );
    }),

  // Import wallet with tokens
  importWithTokens: protectedProcedure
    .input(z.object({
      walletAddress: z.string(),
      chainIds: z.array(z.number().int()),
      includePopularTokens: z.boolean().default(true),
    }))
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);

      // 1. Create wallet account
      const account = await db.insert(accounts).values({
        userId,
        institutionId: null, // Crypto wallets don't need institutions
        accountTypeId: /* crypto wallet type */,
        name: `Wallet ${input.walletAddress.slice(0, 6)}...`,
        metadata: {
          walletAddress: input.walletAddress,
          chainIds: input.chainIds,
          autoSync: true,
        },
      }).returning();

      // 2. Fetch native balances
      const nativeBalances = await Promise.all(
        input.chainIds.map(chainId =>
          multiChainService.getNativeBalance(
            input.walletAddress,
            chainId
          )
        )
      );

      // 3. Fetch token balances (if enabled)
      let tokenBalances: TokenBalance[] = [];
      if (input.includePopularTokens) {
        for (const chainId of input.chainIds) {
          const service = multiChainService.getServiceForChain(chainId);
          if (service.getMultipleTokenBalances) {
            const popularTokens = getPopularTokensForChain(chainId);
            const tokenAddrs = popularTokens.map(t => t.address);
            const balances = await service.getMultipleTokenBalances(
              input.walletAddress,
              tokenAddrs,
              chainId
            );
            tokenBalances.push(...balances);
          }
        }
      }

      // 4. Create holdings for native + token balances
      const allBalances = [...nativeBalances, ...tokenBalances];
      const holdingsToCreate = allBalances
        .filter(b => b.balance.gt(0)) // Only non-zero balances
        .map(balance => ({
          accountId: account.id,
          tokenId: /* lookup or create token */,
          quantity: balance.balance,
          // ... other fields
        }));

      if (holdingsToCreate.length > 0) {
        await db.insert(holdings).values(holdingsToCreate);
      }

      return {
        account,
        holdingsCreated: holdingsToCreate.length,
        nativeBalances: nativeBalances.length,
        tokenBalances: tokenBalances.length,
      };
    }),
});
```

### Step 6: Testing (1 hour)

**File:** `apps/backend/src/tests/chain-services/evm-tokens.test.ts`

```typescript
import { describe, test, expect } from "bun:test";
import { evmService } from "../../services/chain";

describe("EVM Token Support", () => {
  const ETHEREUM_CHAIN_ID = 1;
  const TEST_WALLET = "0x..."; // Use a real wallet with tokens
  const USDT_ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

  test("should fetch token info", async () => {
    const tokenInfo = await evmService.getTokenInfo(
      USDT_ADDRESS,
      ETHEREUM_CHAIN_ID
    );

    expect(tokenInfo.symbol).toBe("USDT");
    expect(tokenInfo.name).toBe("Tether USD");
    expect(tokenInfo.decimals).toBe(6);
  });

  test("should fetch token balance", async () => {
    const balance = await evmService.getTokenBalance(
      TEST_WALLET,
      USDT_ADDRESS,
      ETHEREUM_CHAIN_ID
    );

    expect(balance.symbol).toBe("USDT");
    expect(balance.balance).toBeInstanceOf(Decimal);
    expect(balance.balance.gte(0)).toBe(true);
  });

  test("should fetch multiple token balances", async () => {
    const tokens = [
      USDT_ADDRESS,
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
    ];

    const balances = await evmService.getMultipleTokenBalances(
      TEST_WALLET,
      tokens,
      ETHEREUM_CHAIN_ID
    );

    expect(balances).toHaveLength(2);
    expect(balances[0].symbol).toBe("USDT");
    expect(balances[1].symbol).toBe("USDC");
  });
});
```

---

## 📊 Progress Tracking

### Morning (9am-12pm)

- [ ] Research ERC-20 standard and RPC methods
- [ ] Update base types with token interfaces
- [ ] Start EVM token implementation

### Afternoon (1pm-5pm)

- [ ] Complete EVM token implementation
- [ ] Add popular tokens list
- [ ] Update tRPC router with token endpoints

### Evening (6pm-8pm)

- [ ] Write unit tests
- [ ] Test with real wallets
- [ ] Fix bugs and edge cases

---

## 🎯 Success Metrics

**By End of Day:**

- ✅ Can fetch ERC-20 token balances for any token
- ✅ Can fetch multiple tokens efficiently
- ✅ Token metadata (name, symbol, decimals) working
- ✅ tRPC endpoints for token queries
- ✅ Unit tests passing
- ✅ Works on Ethereum, Polygon, BSC

**Quality Checklist:**

- [ ] All TypeScript types compile
- [ ] All tests passing
- [ ] Rate limiting implemented
- [ ] Error handling comprehensive
- [ ] Decimal.js used for all amounts
- [ ] Logging added for debugging

---

## 🚀 Tomorrow's Plan (Day 4)

**Focus:** Multi-chain token support + token discovery

- TRC-20 tokens on Tron
- SPL tokens on Solana
- Automatic token discovery (scan for all tokens user owns)
- Token price integration with CoinGecko
- Database schema for token metadata

---

## 💡 Notes & Decisions

### Technical Decisions:

1. **Use ethers.js** for EVM interactions (familiar, well-tested)
2. **Start with sequential queries** (simple), optimize with Multicall later
3. **Popular tokens list** instead of full discovery (faster, cheaper)
4. **Cache token metadata** to reduce RPC calls

### Open Questions:

- Should we use Multicall3 for batch queries? (optimization)
- How many popular tokens per chain? (start with 20-30)
- Do we need token allowances? (not for Phase 1.5.1)
- Should we fetch token prices immediately? (yes, use CoinGecko)

---

**Created:** October 3, 2025  
**Updated:** --  
**Completed:** --
