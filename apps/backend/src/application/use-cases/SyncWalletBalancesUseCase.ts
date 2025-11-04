/**
 * SyncWalletBalancesUseCase
 *
 * Synchronizes wallet balances from blockchain for all accounts imported via blockchain services.
 * This use case is designed to be called by scheduled cron jobs.
 *
 * Responsibilities:
 * - Find all accounts with wallet addresses (blockchain imports)
 * - Fetch current balances from blockchain for each wallet
 * - Update existing holdings with new balances (preserving hidden state)
 * - Update holdings when balance goes to zero (keeping them for future syncs)
 * - Create new holdings when wallet owns new tokens
 * - Respect rate limits of blockchain APIs
 *
 * Note: Hidden holdings are updated with new balances but remain hidden.
 * This preserves user intent when they explicitly hide a holding.
 */

import { Container, Service } from 'typedi';
import { BlockchainServiceManager } from '../../infrastructure/external-services/blockchain';
import type { WalletInfo } from '../../infrastructure/external-services/blockchain/types';
import { TokenTypeRepository } from '../../infrastructure/repositories/EnumRepositories';
import { createComponentLogger } from '../../utils/logger';
import { AccountService } from '../services/AccountService';
import { HoldingService } from '../services/HoldingService';
import { PricingService } from '../services/PricingService';
import { TokenService } from '../services/TokenService';
import { UserService } from '../services/UserService';

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
  private readonly accountService = Container.get(AccountService);
  private readonly holdingService = Container.get(HoldingService);
  private readonly tokenService = Container.get(TokenService);
  private readonly userService = Container.get(UserService);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);

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
      // Find all wallet accounts using service
      const walletAccounts = await this.accountService.findWalletAccounts();

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
      const cryptoTokenType = await this.tokenTypeRepository.findByCode('crypto');

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

          // Find the wallet for this specific chain
          let walletInfo: WalletInfo | undefined;
          if (chainName) {
            walletInfo = walletResult.wallets.find((w) => w.chainName === chainName);
          } else {
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

          // Get existing holdings for this account using service (include hidden ones)
          const existingHoldings = await this.holdingService.findByAccount(
            account.id,
            undefined,
            true
          );

          // Batch fetch all tokens for existing holdings
          const existingTokenIds = existingHoldings.map((h) => h.tokenId);
          const existingTokens = await this.tokenService.getTokensByIds(existingTokenIds);
          const tokensMap = new Map(existingTokens.map((t) => [t.id, t]));

          // Create a map of existing holdings by token symbol
          const existingHoldingsMap = new Map<string, (typeof existingHoldings)[0]>();
          for (const holding of existingHoldings) {
            const token = tokensMap.get(holding.tokenId);
            if (token) {
              existingHoldingsMap.set(token.symbol.toUpperCase(), holding);
            }
          }

          // Process each token balance from blockchain
          for (const tokenBalance of walletInfo.balances) {
            try {
              const tokenSymbol = tokenBalance.symbol.toUpperCase();
              const balance = tokenBalance.balance;

              // Find or create token using service
              const token = await this.tokenService.findOrCreateTokenFromBlockchain({
                symbol: tokenSymbol,
                name: tokenBalance.name,
                decimals: tokenBalance.decimals,
                typeId: cryptoTokenType.id,
                iconUrl: tokenBalance.iconUrl,
                isNative: tokenBalance.isNative,
                tokenAddress: tokenBalance.tokenAddress,
                chainName: walletInfo.chainName,
                coinGeckoId: tokenBalance.coinGeckoId,
                metadata: tokenBalance.metadata,
              });

              const existingHolding = existingHoldingsMap.get(tokenSymbol);

              if (balance === '0' || parseFloat(balance) === 0) {
                // For blockchain holdings with zero balance:
                // - Keep the holding for future syncs (balance may increase later)
                // - Preserve hidden state (if user hid it, keep it hidden)
                // - Update the balance to reflect current state
                if (existingHolding) {
                  await this.holdingService.updateHoldingBalance(existingHolding.id, balance);
                  // Only count as removed if it wasn't already hidden
                  if (!existingHolding.isHidden) {
                    holdingsRemoved++;
                  }
                  logger.debug(
                    {
                      accountId: account.id,
                      tokenSymbol,
                      holdingId: existingHolding.id,
                      isHidden: existingHolding.isHidden,
                    },
                    'Updated holding with zero balance (preserving hidden state)'
                  );
                }
              } else {
                // Update or create holding with non-zero balance
                if (existingHolding) {
                  // Update existing holding using service
                  // Keep the hidden state as-is (user may have intentionally hidden it)
                  await this.holdingService.updateHoldingBalance(existingHolding.id, balance);

                  holdingsUpdated++;
                  logger.debug(
                    {
                      accountId: account.id,
                      tokenSymbol,
                      holdingId: existingHolding.id,
                      balance,
                      isHidden: existingHolding.isHidden,
                    },
                    'Updated holding balance (preserving hidden state)'
                  );
                } else {
                  // Create new holding with blockchain source
                  // Use direct DB insert to set source='blockchain'
                  const { db } = await import('../../infrastructure/database/connection');
                  const schema = await import('../../infrastructure/database/schema');

                  const [newHolding] = await db
                    .insert(schema.holdings)
                    .values({
                      userId: account.userId,
                      accountId: account.id,
                      tokenId: token.id,
                      balance,
                      source: 'blockchain',
                      isHidden: false,
                      lastUpdated: new Date(),
                    })
                    .returning();

                  if (!newHolding) {
                    throw new Error('Failed to create holding');
                  }

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

                // Try to fetch current price (non-blocking)
                try {
                  const user = await this.userService.getUserById(account.userId);
                  if (user?.baseCurrencyId) {
                    const baseCurrencyToken = await this.tokenService.getTokenById(
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

          // Update account metadata with last sync time using service
          const updatedMetadata = {
            ...metadata,
            lastSync: new Date().toISOString(),
          };
          await this.accountService.updateAccountMetadata(account.id, updatedMetadata);

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
