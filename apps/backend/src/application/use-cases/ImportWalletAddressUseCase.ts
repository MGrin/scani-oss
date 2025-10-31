/**
 * ImportWalletAddressUseCase
 *
 * Handles importing a crypto wallet address across multiple blockchains:
 * - Detects which chains the wallet exists on
 * - Fetches all token balances from each chain
 * - Creates institution for each chain (if not exists)
 * - Creates account for each chain with wallet metadata
 * - Creates holdings for each token with non-zero balance
 * - Fetches current token prices
 *
 * Reusable for:
 * - Manual wallet import by users
 * - Cron jobs for periodic balance updates
 * - Background sync operations
 */

import { and, eq } from 'drizzle-orm';
import { Container, Service } from 'typedi';
import { db } from '../../infrastructure/database/connection';
import * as schema from '../../infrastructure/database/schema';
import { BlockchainServiceManager } from '../../infrastructure/external-services/blockchain';
import type { WalletInfo } from '../../infrastructure/external-services/blockchain/types';
import { HoldingRepository } from '../../infrastructure/repositories/HoldingRepository';
import { TokenRepository } from '../../infrastructure/repositories/TokenRepository';
import { createComponentLogger } from '../../utils/logger';
import { PricingService } from '../services/PricingService';

const logger = createComponentLogger('use-case:import-wallet');

export interface ImportWalletInput {
  /** Wallet address to import */
  address: string;
  /** Optional display name override */
  displayName?: string;
}

export interface ImportWalletResult {
  /** Created accounts (one per chain) */
  accounts: Array<{
    id: string;
    name: string;
    chainId: string | number;
    chainName: string;
    institutionId: string;
    institutionName: string;
  }>;
  /** Created holdings */
  holdings: Array<{
    id: string;
    accountId: string;
    tokenSymbol: string;
    tokenName: string;
    balance: string;
  }>;
  /** Total number of chains detected */
  chainsDetected: number;
  /** Total number of tokens imported */
  tokensImported: number;
  /** Errors encountered during import */
  errors: Array<{
    chainId: string | number;
    chainName: string;
    error: string;
  }>;
}

/**
 * Import Wallet Address Use Case
 */
@Service()
export class ImportWalletAddressUseCase {
  private readonly blockchainService = Container.get(BlockchainServiceManager);
  private readonly pricingService = Container.get(PricingService);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);

  async execute(input: ImportWalletInput, userId: string): Promise<ImportWalletResult> {
    logger.info(
      {
        userId,
        address: `${input.address.substring(0, 10)}...`,
      },
      'Starting wallet import'
    );

    // Get user info
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);

    if (!user) {
      throw new Error('User not found');
    }

    // Import wallet address across all chains
    const walletResult = await this.blockchainService.importWalletAddress(input.address);

    if (walletResult.wallets.length === 0) {
      logger.warn({ address: input.address }, 'No wallets detected on any chain');
      return {
        accounts: [],
        holdings: [],
        chainsDetected: 0,
        tokensImported: 0,
        errors: [],
      };
    }

    // Process each wallet (one per chain)
    const accounts: ImportWalletResult['accounts'] = [];
    const holdings: ImportWalletResult['holdings'] = [];
    const errors: ImportWalletResult['errors'] = [];

    // Get account type for crypto wallets
    const [walletAccountType] = await db
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.code, 'crypto'))
      .limit(1);

    if (!walletAccountType) {
      throw new Error('Account type "crypto" not found');
    }

    // Get crypto token type
    const [cryptoTokenType] = await db
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.code, 'crypto'))
      .limit(1);

    if (!cryptoTokenType) {
      throw new Error('Token type "crypto" not found');
    }

    for (const wallet of walletResult.wallets) {
      try {
        const result = await this.processWallet(
          wallet,
          userId,
          user.baseCurrencyId || '',
          walletAccountType.id,
          cryptoTokenType.id,
          input.displayName
        );
        accounts.push(result.account);
        holdings.push(...result.holdings);
      } catch (error) {
        logger.error(
          {
            chainId: wallet.chainId,
            chainName: wallet.chainName,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to process wallet on chain'
        );
        errors.push({
          chainId: wallet.chainId,
          chainName: wallet.chainName,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    logger.info(
      {
        userId,
        chainsDetected: walletResult.wallets.length,
        accountsCreated: accounts.length,
        holdingsCreated: holdings.length,
        errors: errors.length,
      },
      'Wallet import completed'
    );

    return {
      accounts,
      holdings,
      chainsDetected: walletResult.wallets.length,
      tokensImported: holdings.length,
      errors,
    };
  }

  /**
   * Process a single wallet on a specific chain
   */
  private async processWallet(
    wallet: WalletInfo,
    userId: string,
    baseCurrencyId: string,
    walletAccountTypeId: string,
    cryptoTokenTypeId: string,
    displayNameOverride?: string
  ): Promise<{
    account: ImportWalletResult['accounts'][0];
    holdings: ImportWalletResult['holdings'];
  }> {
    // Find or create institution for this chain
    const institution = await this.findOrCreateInstitution(wallet.chainName);

    // Generate account name
    const accountName = this.generateAccountName(
      wallet.chainName,
      displayNameOverride || wallet.displayName || wallet.address
    );

    // Check if account already exists for this chain and address
    const existingAccounts = await db
      .select()
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.userId, userId),
          eq(schema.accounts.institutionId, institution.id),
          eq(schema.accounts.name, accountName)
        )
      )
      .limit(1);

    let accountId: string;
    if (existingAccounts.length > 0 && existingAccounts[0]) {
      // Update existing account metadata
      accountId = existingAccounts[0].id;
      await db
        .update(schema.accounts)
        .set({
          metadata: {
            walletAddress: wallet.address,
            chainId: wallet.chainId,
            chainName: wallet.chainName,
            displayName: wallet.displayName,
            lastSync: new Date().toISOString(),
          },
          updatedAt: new Date(),
        })
        .where(eq(schema.accounts.id, accountId));
    } else {
      // Create new account
      const [newAccount] = await db
        .insert(schema.accounts)
        .values({
          userId,
          institutionId: institution.id,
          name: accountName,
          typeId: walletAccountTypeId,
          description: `Crypto wallet on ${wallet.chainName}`,
          metadata: {
            walletAddress: wallet.address,
            chainId: wallet.chainId,
            chainName: wallet.chainName,
            displayName: wallet.displayName,
            lastSync: new Date().toISOString(),
          },
          isActive: true,
        })
        .returning();

      if (!newAccount) {
        throw new Error('Failed to create account');
      }

      accountId = newAccount.id;
    }

    // Create holdings for each token
    const holdings: ImportWalletResult['holdings'] = [];

    for (const tokenBalance of wallet.balances) {
      try {
        // Find or create token
        const token = await this.findOrCreateToken(
          tokenBalance,
          cryptoTokenTypeId,
          wallet.chainName
        );

        // Check if holding already exists
        const existingHolding = await this.holdingRepository.findByAccountAndToken(
          accountId,
          token.id,
          userId
        );

        if (existingHolding) {
          // Update existing holding
          await db
            .update(schema.holdings)
            .set({
              balance: tokenBalance.balance,
              lastUpdated: new Date(),
            })
            .where(eq(schema.holdings.id, existingHolding.id));

          holdings.push({
            id: existingHolding.id,
            accountId,
            tokenSymbol: token.symbol,
            tokenName: token.name,
            balance: tokenBalance.balance,
          });
        } else {
          // Create new holding
          const [newHolding] = await db
            .insert(schema.holdings)
            .values({
              userId,
              accountId,
              tokenId: token.id,
              balance: tokenBalance.balance,
              lastUpdated: new Date(),
            })
            .returning();

          if (!newHolding) {
            throw new Error('Failed to create holding');
          }

          holdings.push({
            id: newHolding.id,
            accountId,
            tokenSymbol: token.symbol,
            tokenName: token.name,
            balance: tokenBalance.balance,
          });
        }

        // Try to fetch current price (non-blocking)
        if (baseCurrencyId) {
          try {
            await this.pricingService.getTokenPrice(token, baseCurrencyId, new Date());
          } catch (error) {
            logger.debug(
              {
                tokenSymbol: token.symbol,
                error: error instanceof Error ? error.message : String(error),
              },
              'Failed to fetch token price (non-critical)'
            );
          }
        }
      } catch (error) {
        logger.error(
          {
            tokenSymbol: tokenBalance.symbol,
            chainName: wallet.chainName,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to create holding for token'
        );
        // Continue with other tokens even if one fails
      }
    }

    return {
      account: {
        id: accountId,
        name: accountName,
        chainId: wallet.chainId,
        chainName: wallet.chainName,
        institutionId: institution.id,
        institutionName: institution.name,
      },
      holdings,
    };
  }

  /**
   * Find or create institution for a blockchain
   */
  private async findOrCreateInstitution(
    chainName: string
  ): Promise<typeof schema.institutions.$inferSelect> {
    // Try to find existing institution by name
    const [existing] = await db
      .select()
      .from(schema.institutions)
      .where(eq(schema.institutions.name, chainName))
      .limit(1);

    if (existing) {
      return existing;
    }

    // Get crypto_wallet institution type
    const [walletType] = await db
      .select()
      .from(schema.institutionTypes)
      .where(eq(schema.institutionTypes.code, 'crypto_wallet'))
      .limit(1);

    if (!walletType) {
      throw new Error('Institution type "crypto_wallet" not found');
    }

    // Create new institution
    const [newInstitution] = await db
      .insert(schema.institutions)
      .values({
        name: chainName,
        typeId: walletType.id,
        description: `${chainName} blockchain`,
        isActive: true,
      })
      .returning();

    if (!newInstitution) {
      throw new Error('Failed to create institution');
    }

    return newInstitution;
  }

  /**
   * Find or create token
   */
  private async findOrCreateToken(
    tokenBalance: WalletInfo['balances'][0],
    cryptoTokenTypeId: string,
    chainName: string
  ): Promise<typeof schema.tokens.$inferSelect> {
    // Try to find existing token by symbol and type
    const existing = await this.tokenRepository.findBySymbolAndType(
      tokenBalance.symbol,
      cryptoTokenTypeId
    );

    if (existing) {
      // Update metadata if we have new information
      if (tokenBalance.iconUrl || tokenBalance.coinGeckoId) {
        const metadata = JSON.parse(existing.providerMetadata || '{}');
        const updated = {
          ...metadata,
          ...(tokenBalance.iconUrl && { iconUrl: tokenBalance.iconUrl }),
          ...(tokenBalance.coinGeckoId && { coinGeckoId: tokenBalance.coinGeckoId }),
          ...(tokenBalance.metadata && { chainMetadata: tokenBalance.metadata }),
        };

        await db
          .update(schema.tokens)
          .set({
            providerMetadata: JSON.stringify(updated),
            updatedAt: new Date(),
          })
          .where(eq(schema.tokens.id, existing.id));
      }
      return existing;
    }

    // Create new token
    const [newToken] = await db
      .insert(schema.tokens)
      .values({
        symbol: tokenBalance.symbol.toUpperCase(),
        name: tokenBalance.name,
        typeId: cryptoTokenTypeId,
        decimals: tokenBalance.decimals,
        iconUrl: tokenBalance.iconUrl || null,
        providerMetadata: JSON.stringify({
          isNative: tokenBalance.isNative,
          tokenAddress: tokenBalance.tokenAddress,
          chain: chainName,
          ...(tokenBalance.coinGeckoId && { coinGeckoId: tokenBalance.coinGeckoId }),
          ...(tokenBalance.metadata && { chainMetadata: tokenBalance.metadata }),
        }),
        isActive: true,
      })
      .returning();

    if (!newToken) {
      throw new Error('Failed to create token');
    }

    return newToken;
  }

  /**
   * Generate account name from chain and display name
   */
  private generateAccountName(chainName: string, displayName: string): string {
    // If display name is a hex address (0x...), Bitcoin address, or Tron address (T...), shorten it
    const isAddress =
      /^0x[0-9a-fA-F]{40}$/.test(displayName) || // Ethereum-like address
      /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(displayName) || // Tron address
      /^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(displayName) || // Bitcoin P2PKH/P2SH
      /^bc1[a-z0-9]{39,59}$/.test(displayName); // Bitcoin Bech32

    if (isAddress && displayName.length > 20) {
      const shortened = `${displayName.substring(0, 6)}...${displayName.substring(displayName.length - 4)}`;
      return `${chainName} - ${shortened}`;
    }

    return `${chainName} - ${displayName}`;
  }
}
