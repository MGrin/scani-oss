/**
 * SyncWalletBalancesUseCase
 *
 * Synchronizes wallet balances from blockchain for all accounts imported via blockchain services.
 * This use case is designed to be called by scheduled cron jobs.
 *
 * Responsibilities:
 * - Find all accounts with wallet addresses (blockchain imports)
 * - Fetch current balances from blockchain for each wallet
 * - Update existing holdings with new balances
 * - Remove holdings when balance goes to zero
 * - Create new holdings when wallet owns new tokens
 * - Respect rate limits of blockchain APIs
 */

import { eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { db } from '../../infrastructure/database/connection';
import * as schema from '../../infrastructure/database/schema';
import { BlockchainServiceManager } from '../../infrastructure/external-services/blockchain';
import type { WalletInfo } from '../../infrastructure/external-services/blockchain/types';
import { TokenRepository } from '../../infrastructure/repositories/TokenRepository';
import { createComponentLogger } from '../../utils/logger';
import { PricingService } from '../services/PricingService';

const logger = createComponentLogger('use-case:sync-wallet-balances');

export interface SyncWalletBalancesResult {
  /** Total number of wallet accounts found */
  accountsFound: number;
  /** Number of accounts successfully synced */
  accountsSynced: number;
  /** Number of accounts that failed to sync */
  accountsFailed: number;
  /** Total holdings updated */
  holdingsUpdated: number;
  /** Total holdings created */
  holdingsCreated: number;
  /** Total holdings removed (balance = 0) */
  holdingsRemoved: number;
  /** Errors encountered during sync */
  errors: Array<{
    accountId: string;
    accountName: string;
    walletAddress: string;
    error: string;
  }>;
  /** Duration of the operation in milliseconds */
  durationMs: number;
}

/**
 * Sync Wallet Balances Use Case
 */
@Service()
export class SyncWalletBalancesUseCase {
  private readonly blockchainService = Container.get(BlockchainServiceManager);
  private readonly pricingService = Container.get(PricingService);
  private readonly tokenRepository = Container.get(TokenRepository);

  async execute(): Promise<SyncWalletBalancesResult> {
    const startTime = Date.now();
    logger.info('Starting wallet balance sync for all blockchain accounts');

    const errors: SyncWalletBalancesResult['errors'] = [];
    let accountsSynced = 0;
    let accountsFailed = 0;
    let holdingsUpdated = 0;
    let holdingsCreated = 0;
    let holdingsRemoved = 0;

    try {
      // Find all accounts with wallet addresses in metadata
      const accounts = await db
        .select({
          id: schema.accounts.id,
          userId: schema.accounts.userId,
          name: schema.accounts.name,
          metadata: schema.accounts.metadata,
          institutionId: schema.accounts.institutionId,
        })
        .from(schema.accounts)
        .where(eq(schema.accounts.isActive, true));

      // Filter accounts that have walletAddress in metadata
      const walletAccounts = accounts.filter((account) => {
        const metadata = account.metadata as Record<string, unknown> | null;
        return metadata && typeof metadata === 'object' && 'walletAddress' in metadata;
      });

      if (walletAccounts.length === 0) {
        logger.info('No wallet accounts found');
        return {
          accountsFound: 0,
          accountsSynced: 0,
          accountsFailed: 0,
          holdingsUpdated: 0,
          holdingsCreated: 0,
          holdingsRemoved: 0,
          errors: [],
          durationMs: Date.now() - startTime,
        };
      }

      logger.info(
        {
          accountCount: walletAccounts.length,
        },
        'Found wallet accounts to sync'
      );

      // Get crypto token type
      const [cryptoTokenType] = await db
        .select()
        .from(schema.tokenTypes)
        .where(eq(schema.tokenTypes.code, 'crypto'))
        .limit(1);

      if (!cryptoTokenType) {
        throw new Error('Token type "crypto" not found');
      }

      // Process each wallet account
      for (const account of walletAccounts) {
        const metadata = account.metadata as Record<string, unknown>;
        const walletAddress = metadata.walletAddress as string;
        const chainName = metadata.chainName as string | undefined;

        if (!walletAddress) {
          logger.warn(
            {
              accountId: account.id,
              accountName: account.name,
            },
            'Account has no wallet address in metadata'
          );
          continue;
        }

        try {
          logger.debug(
            {
              accountId: account.id,
              accountName: account.name,
              walletAddress: `${walletAddress.substring(0, 10)}...`,
              chainName,
            },
            'Syncing wallet balances'
          );

          // Fetch wallet balances from blockchain
          const walletResult = await this.blockchainService.importWalletAddress(walletAddress);

          if (walletResult.wallets.length === 0) {
            logger.warn(
              {
                accountId: account.id,
                walletAddress: `${walletAddress.substring(0, 10)}...`,
              },
              'No wallet data returned from blockchain'
            );
            accountsFailed++;
            errors.push({
              accountId: account.id,
              accountName: account.name,
              walletAddress,
              error: 'No wallet data returned from blockchain',
            });
            continue;
          }

          // Find the wallet for this specific chain (if chainName is available)
          let walletInfo: WalletInfo | undefined;
          if (chainName) {
            walletInfo = walletResult.wallets.find((w) => w.chainName === chainName);
          } else {
            // If no chainName, use the first wallet
            walletInfo = walletResult.wallets[0];
          }

          if (!walletInfo) {
            logger.warn(
              {
                accountId: account.id,
                walletAddress: `${walletAddress.substring(0, 10)}...`,
                chainName,
              },
              'Wallet not found for specified chain'
            );
            accountsFailed++;
            errors.push({
              accountId: account.id,
              accountName: account.name,
              walletAddress,
              error: `Wallet not found for chain: ${chainName}`,
            });
            continue;
          }

          // Get existing holdings for this account
          const existingHoldings = await db
            .select()
            .from(schema.holdings)
            .where(eq(schema.holdings.accountId, account.id));

          // Create a map of existing holdings by token symbol
          const existingHoldingsMap = new Map<string, (typeof existingHoldings)[0]>();
          for (const holding of existingHoldings) {
            const token = await this.tokenRepository.findById(holding.tokenId);
            if (token) {
              existingHoldingsMap.set(token.symbol.toUpperCase(), holding);
            }
          }

          // Process each token balance from blockchain
          for (const tokenBalance of walletInfo.balances) {
            try {
              const tokenSymbol = tokenBalance.symbol.toUpperCase();
              const balance = tokenBalance.balance;

              // Find or create token
              let token = await this.tokenRepository.findBySymbolAndType(
                tokenSymbol,
                cryptoTokenType.id
              );

              if (!token) {
                // Create new token
                const [newToken] = await db
                  .insert(schema.tokens)
                  .values({
                    symbol: tokenSymbol,
                    name: tokenBalance.name,
                    typeId: cryptoTokenType.id,
                    decimals: tokenBalance.decimals,
                    iconUrl: tokenBalance.iconUrl || null,
                    providerMetadata: JSON.stringify({
                      isNative: tokenBalance.isNative,
                      tokenAddress: tokenBalance.tokenAddress,
                      chain: walletInfo.chainName,
                      ...(tokenBalance.coinGeckoId && { coinGeckoId: tokenBalance.coinGeckoId }),
                      ...(tokenBalance.metadata && { chainMetadata: tokenBalance.metadata }),
                    }),
                    isActive: true,
                  })
                  .returning();

                if (!newToken) {
                  throw new Error('Failed to create token');
                }

                token = newToken;
              }

              const existingHolding = existingHoldingsMap.get(tokenSymbol);

              if (balance === '0' || parseFloat(balance) === 0) {
                // Remove holding if balance is zero
                if (existingHolding) {
                  await db
                    .delete(schema.holdings)
                    .where(eq(schema.holdings.id, existingHolding.id));
                  holdingsRemoved++;
                  logger.debug(
                    {
                      accountId: account.id,
                      tokenSymbol,
                      holdingId: existingHolding.id,
                    },
                    'Removed holding with zero balance'
                  );
                }
              } else {
                // Update or create holding
                if (existingHolding) {
                  // Update existing holding
                  await db
                    .update(schema.holdings)
                    .set({
                      balance,
                      lastUpdated: new Date(),
                    })
                    .where(eq(schema.holdings.id, existingHolding.id));
                  holdingsUpdated++;
                  logger.debug(
                    {
                      accountId: account.id,
                      tokenSymbol,
                      holdingId: existingHolding.id,
                      balance,
                    },
                    'Updated holding balance'
                  );
                } else {
                  // Create new holding
                  const [newHolding] = await db
                    .insert(schema.holdings)
                    .values({
                      userId: account.userId,
                      accountId: account.id,
                      tokenId: token.id,
                      balance,
                      lastUpdated: new Date(),
                    })
                    .returning();

                  if (newHolding) {
                    holdingsCreated++;
                    logger.debug(
                      {
                        accountId: account.id,
                        tokenSymbol,
                        holdingId: newHolding.id,
                        balance,
                      },
                      'Created new holding'
                    );
                  }
                }

                // Try to fetch current price (non-blocking)
                try {
                  const [user] = await db
                    .select()
                    .from(schema.users)
                    .where(eq(schema.users.id, account.userId))
                    .limit(1);

                  if (user?.baseCurrencyId) {
                    const baseCurrencyToken = await this.tokenRepository.findById(
                      user.baseCurrencyId
                    );
                    if (baseCurrencyToken) {
                      await this.pricingService.getTokenPrice(
                        token,
                        baseCurrencyToken.symbol,
                        new Date()
                      );
                    }
                  }
                } catch (error) {
                  logger.debug(
                    {
                      tokenSymbol,
                      error: error instanceof Error ? error.message : String(error),
                    },
                    'Failed to fetch token price (non-critical)'
                  );
                }
              }
            } catch (error) {
              logger.error(
                {
                  accountId: account.id,
                  tokenSymbol: tokenBalance.symbol,
                  error: error instanceof Error ? error.message : String(error),
                },
                'Failed to process token balance'
              );
              // Continue with other tokens even if one fails
            }
          }

          // Update account metadata with last sync time
          await db
            .update(schema.accounts)
            .set({
              metadata: {
                ...metadata,
                lastSync: new Date().toISOString(),
              },
              updatedAt: new Date(),
            })
            .where(eq(schema.accounts.id, account.id));

          accountsSynced++;
        } catch (error) {
          accountsFailed++;
          const errorMessage = error instanceof Error ? error.message : String(error);
          errors.push({
            accountId: account.id,
            accountName: account.name,
            walletAddress,
            error: errorMessage,
          });
          logger.error(
            {
              accountId: account.id,
              accountName: account.name,
              walletAddress: `${walletAddress.substring(0, 10)}...`,
              error: errorMessage,
            },
            'Failed to sync wallet balances'
          );
        }
      }

      const durationMs = Date.now() - startTime;

      logger.info(
        {
          accountsFound: walletAccounts.length,
          accountsSynced,
          accountsFailed,
          holdingsUpdated,
          holdingsCreated,
          holdingsRemoved,
          durationMs,
        },
        'Wallet balance sync completed'
      );

      return {
        accountsFound: walletAccounts.length,
        accountsSynced,
        accountsFailed,
        holdingsUpdated,
        holdingsCreated,
        holdingsRemoved,
        errors,
        durationMs,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      logger.error(
        {
          error: error instanceof Error ? error.message : String(error),
          durationMs,
        },
        'Failed to sync wallet balances'
      );

      throw error;
    }
  }
}
