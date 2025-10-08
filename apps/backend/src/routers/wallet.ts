/**
 * Wallet Router
 *
 * Handles crypto wallet import - creates accounts and holdings for wallet addresses
 */

import type { WalletMetadata } from '@scani/shared';
import { TRPCError } from '@trpc/server';
import Decimal from 'decimal.js';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { EVM_CHAINS } from '../config/chains';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { getUserId } from '../middleware/auth';
import type { ERC20TokenBalance, TokenBalance } from '../services/chain/base';
import { detectAddressType, multiChainService } from '../services/chain/multi-chain';
import {
  discoverWalletChains,
  getERC20TokenHoldings,
  getNativeBalance,
} from '../services/etherscan';
import { portfolioValuationService } from '../services/portfolio-valuation';
import { pricingService } from '../services/pricing';
import { isLikelySpamToken } from '../services/pricing/providers/defillama';
import { protectedProcedure, router } from '../trpc';
import { createComponentLogger } from '../utils/logger';

const walletLogger = createComponentLogger('router:wallet');

/**
 * Mapping of chain IDs to native token CoinGecko IDs
 * This ensures native tokens get proper pricing from CoinGecko
 */
const NATIVE_TOKEN_COINGECKO_IDS: Record<number, string> = {
  1: 'ethereum', // Ethereum
  10: 'ethereum', // Optimism (uses ETH)
  56: 'binancecoin', // BSC (uses BNB)
  100: 'xdai', // Gnosis Chain (uses xDAI)
  137: 'matic-network', // Polygon (uses MATIC)
  250: 'fantom', // Fantom (uses FTM)
  324: 'ethereum', // zkSync Era (uses ETH)
  8453: 'ethereum', // Base (uses ETH)
  42161: 'ethereum', // Arbitrum (uses ETH)
  43114: 'avalanche-2', // Avalanche (uses AVAX)
  59144: 'ethereum', // Linea (uses ETH)
  534352: 'ethereum', // Scroll (uses ETH)
};

/**
 * Format wallet address for display
 * Example: 0x1234567890abcdef... -> 0x1234...cdef
 */
function formatAddress(address: string, startChars = 6, endChars = 4): string {
  if (address.length <= startChars + endChars) return address;
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}

/**
 * Get chain name from chain ID
 */
function getChainName(chainId: number): string {
  // EVM chains
  if (EVM_CHAINS[chainId]) {
    return EVM_CHAINS[chainId].name;
  }

  // Non-EVM chains
  switch (chainId) {
    case 0:
      return 'Bitcoin';
    case -1:
      return 'Tron';
    case -2:
      return 'Solana';
    default:
      return `Chain ${chainId}`;
  }
}

/**
 * Helper function to find or create a token
 */
async function findOrCreateToken(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  symbol: string,
  name: string,
  tokenTypeId: string,
  decimals: number,
  metadata: Record<string, unknown>
): Promise<string> {
  // Try to find existing token
  const [existingToken] = await tx
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(eq(schema.tokens.symbol, symbol))
    .limit(1);

  if (existingToken) {
    walletLogger.info(
      { symbol, tokenId: existingToken.id },
      `Using existing token ${symbol} (${existingToken.id})`
    );
    return existingToken.id;
  }

  // Create new token
  const [newToken] = await tx
    .insert(schema.tokens)
    .values({
      symbol,
      name,
      typeId: tokenTypeId,
      decimals,
      providerMetadata: JSON.stringify(metadata),
      isActive: true,
    })
    .returning();

  if (!newToken) {
    throw new Error(`Failed to create token ${symbol}`);
  }

  walletLogger.info({ symbol, tokenId: newToken.id }, `Created token ${symbol} (${newToken.id})`);
  return newToken.id;
}

export const walletRouter = router({
  /**
   * Import wallet address - creates accounts and holdings for all chains with balances
   *
   * This is the main entry point for wallet import functionality.
   * It will:
   * 1. Detect address type (EVM, Bitcoin, Tron, Solana)
   * 2. Fetch balances from all relevant chains
   * 3. For each chain with non-zero balance:
   *    - Find institution by chain name + crypto_wallet type
   *    - Check if account already exists (same address + chain)
   *    - Create account if it doesn't exist
   *    - Create holdings for native token balance
   *
   * Returns summary of created accounts and holdings.
   */
  importWalletAddress: protectedProcedure
    .input(
      z.object({
        walletAddress: z.string().min(1, 'Wallet address is required'),
        accountName: z.string().optional(), // Optional custom name
      })
    )
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);

      return await db.transaction(async (tx) => {
        try {
          // Step 1: Detect address type
          const addressType = detectAddressType(input.walletAddress);

          if (addressType === 'unknown') {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message:
                'Unsupported wallet address format. Supported: EVM (0x...), Bitcoin (1/3/bc1...), Tron (T...), Solana',
            });
          }

          walletLogger.info(
            { addressType, walletAddress: input.walletAddress, userId },
            `Importing ${addressType} wallet ${input.walletAddress} for user ${userId}`
          );

          // Step 2: Handle based on wallet type
          let nativeBalances: TokenBalance[] = [];
          const erc20Balances: Array<
            ERC20TokenBalance & { chainId: number; coingeckoId?: string }
          > = [];

          if (addressType === 'evm') {
            // ============================================
            // EVM WALLET IMPORT FLOW (Optimized with V2 API)
            // ============================================

            walletLogger.info(
              { addressType: 'evm', walletAddress: input.walletAddress },
              'EVM address detected, discovering active chains via Etherscan V2 API...'
            );

            // Step 2.1: Discover which EVM chains this wallet exists on
            // This checks all EVM chains in parallel using Etherscan V2 API
            const activeChainIds = await discoverWalletChains(input.walletAddress);

            if (activeChainIds.length === 0) {
              walletLogger.warn(
                { walletAddress: input.walletAddress },
                'No activity found on any EVM chains for this wallet'
              );
              throw new TRPCError({
                code: 'NOT_FOUND',
                message:
                  'This wallet has no activity on any supported EVM chains. Please ensure the address is correct and has been used.',
              });
            }

            walletLogger.info(
              {
                activeChainCount: activeChainIds.length,
                chains: activeChainIds,
              },
              `Wallet is active on ${
                activeChainIds.length
              } EVM chain(s): ${activeChainIds.join(', ')}`
            );

            // Step 2.2: For each active chain, fetch native and ERC-20 balances
            for (const chainId of activeChainIds) {
              try {
                const chainConfig = EVM_CHAINS[chainId];
                if (!chainConfig) {
                  walletLogger.warn(
                    { chainId },
                    `Chain config not found for chain ${chainId}, skipping`
                  );
                  continue;
                }

                walletLogger.info(
                  { chainId, chainName: chainConfig.name },
                  `Fetching balances for ${chainConfig.name} (${chainId})...`
                );

                // Step 2.2a: Get native balance
                const nativeBalance = await getNativeBalance(input.walletAddress, chainId);

                if (nativeBalance && !nativeBalance.balance.isZero()) {
                  // Convert from wei to actual token units (e.g., wei -> ETH)
                  const balanceInTokenUnits = nativeBalance.balance.div(
                    new Decimal(10).pow(chainConfig.nativeCurrency.decimals)
                  );

                  nativeBalances.push({
                    address: nativeBalance.walletAddress,
                    chainId: nativeBalance.chainId,
                    chainName: nativeBalance.chainName,
                    tokenSymbol: chainConfig.nativeCurrency.symbol,
                    balance: balanceInTokenUnits,
                    decimals: chainConfig.nativeCurrency.decimals,
                    tokenName: chainConfig.nativeCurrency.name,
                  });

                  walletLogger.info(
                    {
                      chainId,
                      chainName: chainConfig.name,
                      balance: nativeBalance.balance
                        .div(new Decimal(10).pow(chainConfig.nativeCurrency.decimals))
                        .toString(),
                      symbol: chainConfig.nativeCurrency.symbol,
                    },
                    `Native balance: ${nativeBalance.balance
                      .div(new Decimal(10).pow(chainConfig.nativeCurrency.decimals))
                      .toString()} ${chainConfig.nativeCurrency.symbol}`
                  );
                }

                // Step 2.2b: Get ERC-20 token holdings
                const erc20Tokens = await getERC20TokenHoldings(input.walletAddress, chainId);

                if (erc20Tokens.length === 0) {
                  walletLogger.info(
                    { chainId, chainName: chainConfig.name },
                    `No ERC-20 tokens found on ${chainConfig.name}`
                  );
                  continue;
                }

                walletLogger.info(
                  {
                    chainId,
                    chainName: chainConfig.name,
                    tokenCount: erc20Tokens.length,
                  },
                  `Found ${erc20Tokens.length} ERC-20 token(s) on ${chainConfig.name}, filtering spam...`
                );

                // Step 2.2c: Filter spam tokens and convert balances
                const validTokens = erc20Tokens
                  .filter((token) => token.balance && token.balance !== '0')
                  .filter((token) => {
                    // Filter out obvious spam tokens
                    if (isLikelySpamToken(token)) {
                      walletLogger.debug(
                        {
                          chainId,
                          tokenAddress: token.address,
                          tokenSymbol: token.symbol,
                          tokenName: token.name,
                        },
                        `Token ${token.symbol} appears to be spam, skipping`
                      );
                      return false;
                    }
                    return true;
                  })
                  .map((token) => {
                    // Convert balance from wei to token units
                    const balanceInTokenUnits = new Decimal(token.balance).div(
                      new Decimal(10).pow(token.decimals)
                    );

                    return {
                      address: token.address,
                      symbol: token.symbol,
                      name: token.name,
                      decimals: token.decimals,
                      balance: balanceInTokenUnits,
                      chainId,
                      chainName: chainConfig.name,
                      walletAddress: input.walletAddress,
                    };
                  });

                walletLogger.info(
                  {
                    chainId,
                    chainName: chainConfig.name,
                    totalTokens: erc20Tokens.length,
                    validTokens: validTokens.length,
                    skippedSpam: erc20Tokens.length - validTokens.length,
                  },
                  `${validTokens.length}/${erc20Tokens.length} tokens passed spam filter (${
                    erc20Tokens.length - validTokens.length
                  } spam tokens filtered out)`
                );

                erc20Balances.push(...validTokens);
              } catch (error) {
                walletLogger.warn(
                  {
                    chainId,
                    error: error instanceof Error ? error.message : String(error),
                  },
                  `Failed to fetch balances for chain ${chainId}: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                );
                // Continue with other chains even if one fails
              }
            }

            walletLogger.info(
              {
                nativeBalanceCount: nativeBalances.length,
                erc20TokenCount: erc20Balances.length,
                totalChainsProcessed: activeChainIds.length,
              },
              `EVM wallet import discovery complete: ${nativeBalances.length} native balances, ${erc20Balances.length} ERC-20 tokens (spam filtered, pricing handled by pricing service)`
            );
          } else {
            // ============================================
            // NON-EVM WALLET IMPORT FLOW (Bitcoin, Solana, etc.)
            // ============================================

            walletLogger.info(
              { addressType },
              `Non-EVM wallet detected (${addressType}), using multi-chain service...`
            );

            // Use existing multi-chain service for non-EVM chains
            nativeBalances = await multiChainService.getAllBalances(input.walletAddress);

            walletLogger.info(
              { nativeBalancesCount: nativeBalances.length },
              `Found ${nativeBalances.length} chain(s) with non-zero native balances`
            );
          }

          // Continue with the rest of the wallet import flow...
          walletLogger.info(
            {
              totalNativeBalances: nativeBalances.length,
              totalErc20Balances: erc20Balances.length,
            },
            `Balance discovery complete - proceeding to create accounts and holdings`
          );

          if (nativeBalances.length === 0 && erc20Balances.length === 0) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'No balances found for this wallet address',
            });
          }

          walletLogger.info(
            {
              nativeCount: nativeBalances.length,
              erc20Count: erc20Balances.length,
            },
            `Total assets found: ${nativeBalances.length} native + ${erc20Balances.length} ERC-20 tokens`
          );

          // Step 3: Get crypto_wallet institution type
          const [cryptoWalletType] = await tx
            .select({ id: schema.institutionTypes.id })
            .from(schema.institutionTypes)
            .where(eq(schema.institutionTypes.code, 'crypto_wallet'))
            .limit(1);

          if (!cryptoWalletType) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Crypto wallet institution type not found',
            });
          }

          // Step 4: Get crypto account type
          const [accountType] = await tx
            .select({ id: schema.accountTypes.id })
            .from(schema.accountTypes)
            .where(eq(schema.accountTypes.code, 'crypto'))
            .limit(1);

          if (!accountType) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Crypto account type not found',
            });
          }

          const accountsCreated: Array<{
            id: string;
            name: string;
            chainName: string;
            chainId: number;
            balance: string;
            holdings: Array<{
              id: string;
              tokenSymbol: string;
              tokenName: string;
              quantity: string;
            }>;
          }> = [];

          let totalAccountsCreated = 0;
          let totalAccountsSkipped = 0;
          let totalHoldingsCreated = 0;

          // Group balances by chain for processing
          const balancesByChain = new Map<
            number,
            {
              native?: (typeof nativeBalances)[0];
              erc20: (typeof erc20Balances)[0][];
            }
          >();

          // Add native balances
          for (const balance of nativeBalances) {
            const existing = balancesByChain.get(balance.chainId) || {
              erc20: [],
            };
            existing.native = balance;
            balancesByChain.set(balance.chainId, existing);
          }

          // Add ERC-20 balances
          for (const balance of erc20Balances) {
            const existing = balancesByChain.get(balance.chainId) || {
              erc20: [],
            };
            existing.erc20.push(balance);
            balancesByChain.set(balance.chainId, existing);
          }

          walletLogger.info(
            { uniqueChainCount: balancesByChain.size },
            `Processing ${balancesByChain.size} unique chains`
          );

          // Step 5: Process each chain with balances
          for (const [chainId, { native, erc20 }] of balancesByChain.entries()) {
            const chainName = getChainName(chainId);

            walletLogger.info(
              {
                chainId,
                chainName,
                hasNative: !!native,
                erc20Count: erc20.length,
              },
              `Processing ${chainName} (chainId: ${chainId}): ${
                native ? '1 native token' : 'no native'
              } + ${erc20.length} ERC-20 tokens`
            );

            // Step 5.1: Find institution by chain name
            const [institution] = await tx
              .select({
                id: schema.institutions.id,
                name: schema.institutions.name,
              })
              .from(schema.institutions)
              .where(
                and(
                  eq(schema.institutions.name, chainName),
                  eq(schema.institutions.typeId, cryptoWalletType.id),
                  eq(schema.institutions.isActive, true)
                )
              )
              .limit(1);

            if (!institution) {
              walletLogger.warn(
                { chainName, chainId },
                `Institution not found for chain: ${chainName}, skipping`
              );
              continue;
            }

            // Step 5.2: Check if account already exists (same wallet address + chain)
            let account: { id: string } | null = null;
            const [existingAccount] = await tx
              .select({
                id: schema.accounts.id,
                metadata: schema.accounts.metadata,
              })
              .from(schema.accounts)
              .where(
                and(
                  eq(schema.accounts.userId, userId),
                  eq(schema.accounts.institutionId, institution.id),
                  eq(schema.accounts.isActive, true)
                )
              )
              .limit(1);

            // Check if existing account matches wallet address
            if (existingAccount) {
              const metadata = existingAccount.metadata as WalletMetadata | undefined;
              if (metadata?.walletAddress?.toLowerCase() === input.walletAddress.toLowerCase()) {
                walletLogger.info(
                  { chainName, accountId: existingAccount.id },
                  `Account already exists for ${chainName}, using existing account`
                );
                account = existingAccount;
                totalAccountsSkipped++;
              }
            }

            // Step 5.3: Create account if it doesn't exist
            if (!account) {
              const accountName =
                input.accountName || `${chainName} (${formatAddress(input.walletAddress)})`;

              const metadata: WalletMetadata = {
                walletAddress: input.walletAddress,
                addressType,
                chainIds: [chainId],
                autoSync: false,
              };

              const [newAccount] = await tx
                .insert(schema.accounts)
                .values({
                  userId,
                  institutionId: institution.id,
                  name: accountName,
                  typeId: accountType.id,
                  metadata: metadata as unknown as Record<string, unknown>,
                  isActive: true,
                })
                .returning();

              if (!newAccount) {
                walletLogger.error(
                  { chainName, chainId },
                  `Failed to create account for ${chainName}`
                );
                continue;
              }

              account = newAccount;
              totalAccountsCreated++;
              walletLogger.info(
                { chainName, accountId: account.id },
                `Created account ${account.id} for ${chainName}`
              );
            }

            // Step 5.4: Process holdings (native + ERC-20 tokens)
            const holdingsForAccount: Array<{
              id: string;
              tokenSymbol: string;
              tokenName: string;
              quantity: string;
            }> = [];

            // Get crypto token type once
            const [cryptoTokenType] = await tx
              .select({ id: schema.tokenTypes.id })
              .from(schema.tokenTypes)
              .where(eq(schema.tokenTypes.code, 'crypto'))
              .limit(1);

            if (!cryptoTokenType) {
              walletLogger.error({}, 'Crypto token type not found');
              continue;
            }

            // Process native token if exists
            if (native) {
              try {
                // Build metadata with CoinGecko ID for proper pricing
                const nativeTokenMetadata: Record<string, unknown> = {
                  chainId: native.chainId,
                  chainName: native.chainName,
                  isNativeToken: true,
                };

                // Add CoinGecko ID if available for this chain
                const coinGeckoId = NATIVE_TOKEN_COINGECKO_IDS[native.chainId];
                if (coinGeckoId) {
                  nativeTokenMetadata.coingecko = { id: coinGeckoId };
                }

                const tokenId = await findOrCreateToken(
                  tx,
                  native.tokenSymbol,
                  native.tokenSymbol,
                  cryptoTokenType.id,
                  native.decimals,
                  nativeTokenMetadata
                );

                const [holding] = await tx
                  .insert(schema.holdings)
                  .values({
                    userId,
                    accountId: account.id,
                    tokenId,
                    balance: native.balance.toString(),
                    lastUpdated: new Date(),
                  })
                  .returning();

                if (holding) {
                  totalHoldingsCreated++;
                  walletLogger.info(
                    {
                      holdingId: holding.id,
                      tokenSymbol: native.tokenSymbol,
                      balance: native.balance.toString(),
                    },
                    `Created holding ${
                      holding.id
                    }: ${native.balance.toString()} ${native.tokenSymbol}`
                  );

                  holdingsForAccount.push({
                    id: holding.id,
                    tokenSymbol: native.tokenSymbol,
                    tokenName: native.tokenSymbol,
                    quantity: native.balance.toString(),
                  });
                }
              } catch (error) {
                walletLogger.error(
                  {
                    error: error instanceof Error ? error.message : String(error),
                  },
                  `Failed to create native token holding: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                );
              }
            }

            // Process ERC-20 tokens
            for (const erc20Token of erc20) {
              try {
                // Build metadata with contract address for pricing service
                // Format supports CoinGecko (if available) and DeFiLlama (fallback)
                const tokenMetadata: Record<string, unknown> = {
                  chainId: erc20Token.chainId,
                  contractAddress: erc20Token.address, // DeFiLlama uses this
                  isERC20: true,
                };

                // Validate that token can be priced before creating it
                // Skip tokens that cannot be priced by CoinGecko or DeFiLlama
                const validation = await pricingService.canTokenBePriced(
                  {
                    symbol: erc20Token.symbol,
                    name: erc20Token.name,
                    metadata: tokenMetadata,
                    typeCode: 'crypto',
                  },
                  'USD'
                );

                if (!validation.canBePriced) {
                  walletLogger.warn(
                    {
                      symbol: erc20Token.symbol,
                      contractAddress: erc20Token.address,
                      chainId: erc20Token.chainId,
                      reason: validation.reason,
                    },
                    `Skipping unpriceable token ${erc20Token.symbol} - ${validation.reason}`
                  );
                  continue; // Skip this token - don't create it
                }

                walletLogger.info(
                  {
                    symbol: erc20Token.symbol,
                    provider: validation.provider,
                  },
                  `Token ${erc20Token.symbol} can be priced via ${validation.provider}`
                );

                const tokenId = await findOrCreateToken(
                  tx,
                  erc20Token.symbol,
                  erc20Token.name,
                  cryptoTokenType.id,
                  erc20Token.decimals,
                  tokenMetadata
                );

                const [holding] = await tx
                  .insert(schema.holdings)
                  .values({
                    userId,
                    accountId: account.id,
                    tokenId,
                    balance: erc20Token.balance.toString(),
                    lastUpdated: new Date(),
                  })
                  .returning();

                if (holding) {
                  totalHoldingsCreated++;
                  walletLogger.info(
                    {
                      holdingId: holding.id,
                      tokenSymbol: erc20Token.symbol,
                      balance: erc20Token.balance.toString(),
                    },
                    `Created holding ${
                      holding.id
                    }: ${erc20Token.balance.toString()} ${erc20Token.symbol}`
                  );

                  holdingsForAccount.push({
                    id: holding.id,
                    tokenSymbol: erc20Token.symbol,
                    tokenName: erc20Token.name,
                    quantity: erc20Token.balance.toString(),
                  });
                }
              } catch (error) {
                walletLogger.error(
                  {
                    tokenSymbol: erc20Token.symbol,
                    error: error instanceof Error ? error.message : String(error),
                  },
                  `Failed to create ERC-20 token holding for ${
                    erc20Token.symbol
                  }: ${error instanceof Error ? error.message : String(error)}`
                );
              }
            }

            // Add to response
            if (holdingsForAccount.length > 0) {
              accountsCreated.push({
                id: account.id,
                name: input.accountName || `${chainName} (${formatAddress(input.walletAddress)})`,
                chainName,
                chainId,
                balance: '0', // Will be calculated by portfolio service
                holdings: holdingsForAccount,
              });
            }
          }

          walletLogger.info(
            {
              accountsCreated: totalAccountsCreated,
              accountsSkipped: totalAccountsSkipped,
              holdingsCreated: totalHoldingsCreated,
            },
            `Wallet import complete: ${totalAccountsCreated} accounts created, ${totalAccountsSkipped} skipped, ${totalHoldingsCreated} holdings created`
          );

          // Trigger pricing for all imported tokens immediately (background, don't await)
          if (totalHoldingsCreated > 0) {
            walletLogger.info(
              { userId, holdingsCreated: totalHoldingsCreated },
              'Triggering initial pricing for imported wallet tokens...'
            );

            // Fire and forget - update prices in background
            portfolioValuationService
              .getUserPortfolioValue(userId)
              .then(() => {
                walletLogger.info({ userId }, 'Initial pricing completed for imported wallet');
              })
              .catch((error) => {
                walletLogger.error(
                  {
                    userId,
                    error: error instanceof Error ? error.message : String(error),
                  },
                  'Failed to fetch initial prices for imported wallet (will retry on dashboard view)'
                );
              });
          }

          return {
            success: true,
            accountsCreated: totalAccountsCreated,
            accountsSkipped: totalAccountsSkipped,
            holdingsCreated: totalHoldingsCreated,
            accounts: accountsCreated,
          };
        } catch (error) {
          walletLogger.error(
            { error: error instanceof Error ? error.message : String(error) },
            `Failed to import wallet: ${error instanceof Error ? error.message : String(error)}`
          );

          // Rollback transaction by re-throwing
          throw error;
        }
      });
    }),
});
