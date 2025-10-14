import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { EVM_CHAINS } from '../../config/chains';
import type { DatabaseTransaction } from '../../domain/interfaces/repositories/IBaseRepository';
import type {
  ERC20TokenBalance,
  TokenBalance,
} from '../../infrastructure/external-services/blockchain/base';
import {
  discoverWalletChains,
  getERC20TokenHoldings,
  getNativeBalance,
} from '../../infrastructure/external-services/blockchain/etherscan';
import {
  detectAddressType,
  multiChainService,
} from '../../infrastructure/external-services/blockchain/multi-chain';
import { isLikelySpamToken } from '../../infrastructure/external-services/pricing/providers/defillama';
import { AccountRepository } from '../../infrastructure/repositories/AccountRepository';
import {
  AccountTypeRepository,
  InstitutionTypeRepository,
  TokenTypeRepository,
} from '../../infrastructure/repositories/EnumRepositories';
import { HoldingRepository } from '../../infrastructure/repositories/HoldingRepository';
import { InstitutionRepository } from '../../infrastructure/repositories/InstitutionRepository';
import { TokenRepository } from '../../infrastructure/repositories/TokenRepository';
import { BaseService } from '../services/BaseService';
import { PortfolioValuationService } from '../services/PortfolioValuationService';
import { PricingService } from '../services/PricingService';

/**
 * Mapping of chain IDs to native token CoinGecko IDs
 */
const NATIVE_TOKEN_COINGECKO_IDS: Record<number, string> = {
  1: 'ethereum',
  10: 'ethereum',
  56: 'binancecoin',
  100: 'xdai',
  137: 'matic-network',
  250: 'fantom',
  324: 'ethereum',
  8453: 'ethereum',
  42161: 'ethereum',
  43114: 'avalanche-2',
  59144: 'ethereum',
  534352: 'ethereum',
};

export interface ImportWalletInput {
  walletAddress: string;
  accountName?: string;
}

export interface ImportWalletResult {
  success: boolean;
  accountsCreated: number;
  accountsSkipped: number;
  holdingsCreated: number;
  accounts: Array<{
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
  }>;
}

/**
 * ImportWalletAddressUseCase
 *
 * Handles complete wallet import workflow for crypto wallets.
 * Supports multi-chain detection and balance fetching.
 *
 * **Business Rules:**
 * 1. Detects address type (EVM, Bitcoin, Tron, Solana)
 * 2. Fetches balances from all relevant chains
 * 3. Filters spam tokens
 * 4. Creates accounts per chain
 * 5. Creates holdings for native and ERC-20 tokens
 * 6. Validates token pricing before creation
 * 7. Triggers background price updates
 */
@Service()
export class ImportWalletAddressUseCase extends BaseService {
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly institutionRepository = Container.get(InstitutionRepository);
  private readonly institutionTypeRepository = Container.get(InstitutionTypeRepository);
  private readonly accountTypeRepository = Container.get(AccountTypeRepository);
  private readonly tokenTypeRepository = Container.get(TokenTypeRepository);
  private readonly pricingService = Container.get(PricingService);
  private readonly portfolioValuationService = Container.get(PortfolioValuationService);

  constructor() {
    super('ImportWalletAddressUseCase');
  }

  /**
   * Execute wallet import
   */
  async execute(input: ImportWalletInput, userId: string): Promise<ImportWalletResult> {
    try {
      this.logInfo('Importing wallet address', {
        walletAddress: input.walletAddress,
        userId,
      });

      this.validateNonEmptyString(input.walletAddress, 'walletAddress');

      return await this.withTransaction(async (tx) => {
        // Step 1: Detect address type
        const addressType = detectAddressType(input.walletAddress);

        if (addressType === 'unknown') {
          throw new Error(
            'Unsupported wallet address format. Supported: EVM (0x...), Bitcoin (1/3/bc1...), Tron (T...), Solana'
          );
        }

        this.logInfo(`Detected ${addressType} wallet type`);

        // Step 2: Fetch balances
        const { nativeBalances, erc20Balances } = await this.fetchBalances(
          input.walletAddress,
          addressType
        );

        // Step 3: Validate we have balances
        if (nativeBalances.length === 0 && erc20Balances.length === 0) {
          throw new Error('No balances found for this wallet address');
        }

        this.logInfo(
          `Balance discovery complete: ${nativeBalances.length} native + ${erc20Balances.length} ERC-20`
        );

        // Step 4: Get required enum types
        const { cryptoWalletType, accountType, cryptoTokenType } = await this.getRequiredTypes(tx);

        // Step 5: Group balances by chain
        const balancesByChain = this.groupBalancesByChain(nativeBalances, erc20Balances);

        this.logInfo(`Processing ${balancesByChain.size} unique chains`);

        // Step 6: Process each chain
        const result = await this.processChains(
          balancesByChain,
          input,
          userId,
          cryptoWalletType.id,
          accountType.id,
          cryptoTokenType.id,
          tx
        );

        // Step 7: Trigger background pricing
        if (result.holdingsCreated > 0) {
          this.triggerBackgroundPricing(userId);
        }

        return result;
      });
    } catch (error) {
      throw this.handleError(error, 'execute');
    }
  }

  /**
   * Fetch balances based on wallet type
   */
  private async fetchBalances(
    walletAddress: string,
    addressType: string
  ): Promise<{
    nativeBalances: TokenBalance[];
    erc20Balances: Array<ERC20TokenBalance & { chainId: number; coingeckoId?: string }>;
  }> {
    const nativeBalances: TokenBalance[] = [];
    const erc20Balances: Array<ERC20TokenBalance & { chainId: number; coingeckoId?: string }> = [];

    if (addressType === 'evm') {
      // EVM wallet flow
      this.logInfo('EVM address detected, discovering active chains...');

      const activeChainIds = await discoverWalletChains(walletAddress);

      if (activeChainIds.length === 0) {
        throw new Error(
          'This wallet has no activity on any supported EVM chains. Please ensure the address is correct and has been used.'
        );
      }

      this.logInfo(
        `Wallet is active on ${activeChainIds.length} EVM chain(s): ${activeChainIds.join(', ')}`
      );

      // Fetch balances for each active chain
      for (const chainId of activeChainIds) {
        try {
          const chainConfig = EVM_CHAINS[chainId];
          if (!chainConfig) {
            this.logWarning(`Chain config not found for chain ${chainId}, skipping`);
            continue;
          }

          this.logInfo(`Fetching balances for ${chainConfig.name} (${chainId})...`);

          // Get native balance
          const nativeBalance = await getNativeBalance(walletAddress, chainId);

          if (nativeBalance && !nativeBalance.balance.isZero()) {
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

            this.logInfo(
              `Native balance: ${balanceInTokenUnits.toString()} ${chainConfig.nativeCurrency.symbol}`
            );
          }

          // Get ERC-20 tokens
          const erc20Tokens = await getERC20TokenHoldings(walletAddress, chainId);

          if (erc20Tokens.length > 0) {
            this.logInfo(
              `Found ${erc20Tokens.length} ERC-20 token(s) on ${chainConfig.name}, filtering spam...`
            );

            // Filter and convert
            const validTokens = erc20Tokens
              .filter((token) => token.balance && token.balance !== '0')
              .filter((token) => {
                if (isLikelySpamToken(token)) {
                  this.logDebug(`Token ${token.symbol} appears to be spam, skipping`);
                  return false;
                }
                return true;
              })
              .map((token) => {
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
                  walletAddress,
                };
              });

            this.logInfo(`${validTokens.length}/${erc20Tokens.length} tokens passed spam filter`);

            erc20Balances.push(...validTokens);
          }
        } catch (error) {
          this.logWarning(
            `Failed to fetch balances for chain ${chainId}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    } else {
      // Non-EVM wallet flow
      this.logInfo(`Non-EVM wallet detected (${addressType}), using multi-chain service...`);
      const balances = await multiChainService.getAllBalances(walletAddress);
      nativeBalances.push(...balances);
      this.logInfo(`Found ${balances.length} chain(s) with non-zero native balances`);
    }

    return { nativeBalances, erc20Balances };
  }

  /**
   * Get required enum types
   */
  private async getRequiredTypes(tx: DatabaseTransaction) {
    const cryptoWalletType = await this.institutionTypeRepository.findByCode('crypto_wallet', tx);
    this.assertExists(cryptoWalletType, 'Crypto wallet institution type not found');

    const accountType = await this.accountTypeRepository.findByCode('crypto', tx);
    this.assertExists(accountType, 'Crypto account type not found');

    const cryptoTokenType = await this.tokenTypeRepository.findByCode('crypto', tx);
    this.assertExists(cryptoTokenType, 'Crypto token type not found');

    return { cryptoWalletType, accountType, cryptoTokenType };
  }

  /**
   * Group balances by chain
   */
  private groupBalancesByChain(
    nativeBalances: TokenBalance[],
    erc20Balances: Array<ERC20TokenBalance & { chainId: number }>
  ) {
    const balancesByChain = new Map<
      number,
      {
        native?: TokenBalance;
        erc20: Array<ERC20TokenBalance & { chainId: number }>;
      }
    >();

    for (const balance of nativeBalances) {
      const existing = balancesByChain.get(balance.chainId) || { erc20: [] };
      existing.native = balance;
      balancesByChain.set(balance.chainId, existing);
    }

    for (const balance of erc20Balances) {
      const existing = balancesByChain.get(balance.chainId) || { erc20: [] };
      existing.erc20.push(balance);
      balancesByChain.set(balance.chainId, existing);
    }

    return balancesByChain;
  }

  /**
   * Process all chains with balances
   */
  private async processChains(
    balancesByChain: Map<
      number,
      { native?: TokenBalance; erc20: Array<ERC20TokenBalance & { chainId: number }> }
    >,
    input: ImportWalletInput,
    userId: string,
    institutionTypeId: string,
    accountTypeId: string,
    cryptoTokenTypeId: string,
    tx: DatabaseTransaction
  ): Promise<ImportWalletResult> {
    const accountsCreated: ImportWalletResult['accounts'] = [];
    let totalAccountsCreated = 0;
    let totalAccountsSkipped = 0;
    let totalHoldingsCreated = 0;

    for (const [chainId, { native, erc20 }] of balancesByChain.entries()) {
      const chainName = this.getChainName(chainId);

      this.logInfo(
        `Processing ${chainName} (chainId: ${chainId}): ${native ? '1 native' : 'no native'} + ${erc20.length} ERC-20`
      );

      try {
        // Find or create institution
        const institution = await this.findOrCreateInstitution(chainName, institutionTypeId, tx);

        // Check for existing account
        const metadataStr = JSON.stringify({
          walletAddress: input.walletAddress,
          chainId,
          chainName,
        });
        const existingAccount = await this.accountRepository.findByInstitutionAndMetadata(
          institution.id,
          metadataStr,
          tx
        );

        if (existingAccount) {
          this.logInfo(`Account already exists for ${chainName}, skipping`);
          totalAccountsSkipped++;
          continue;
        }

        // Create account
        const account = await this.accountRepository.create(
          {
            userId,
            institutionId: institution.id,
            name: input.accountName || `${chainName} (${this.formatAddress(input.walletAddress)})`,
            typeId: accountTypeId,
            metadata: JSON.stringify({
              walletAddress: input.walletAddress,
              chainId,
              chainName,
            }),
            isActive: true,
          },
          tx
        );

        this.assertExists(account, 'Failed to create account');
        totalAccountsCreated++;

        // Create holdings
        const holdingsForAccount = await this.createHoldings(
          account.id,
          userId,
          native,
          erc20,
          cryptoTokenTypeId,
          chainId,
          tx
        );

        totalHoldingsCreated += holdingsForAccount.length;

        if (holdingsForAccount.length > 0) {
          accountsCreated.push({
            id: account.id,
            name: account.name,
            chainName,
            chainId,
            balance: '0',
            holdings: holdingsForAccount,
          });
        }
      } catch (error) {
        this.logError(
          `Failed to process chain ${chainName}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    this.logInfo(
      `Wallet import complete: ${totalAccountsCreated} accounts created, ${totalAccountsSkipped} skipped, ${totalHoldingsCreated} holdings created`
    );

    return {
      success: true,
      accountsCreated: totalAccountsCreated,
      accountsSkipped: totalAccountsSkipped,
      holdingsCreated: totalHoldingsCreated,
      accounts: accountsCreated,
    };
  }

  /**
   * Create holdings for native and ERC-20 tokens
   */
  private async createHoldings(
    accountId: string,
    userId: string,
    native: TokenBalance | undefined,
    erc20Tokens: Array<ERC20TokenBalance & { chainId: number }>,
    cryptoTokenTypeId: string,
    chainId: number,
    tx: DatabaseTransaction
  ) {
    const holdings: Array<{
      id: string;
      tokenSymbol: string;
      tokenName: string;
      quantity: string;
    }> = [];

    // Create native token holding
    if (native && !native.balance.isZero()) {
      try {
        const coingeckoId = NATIVE_TOKEN_COINGECKO_IDS[chainId];
        const tokenMetadata: Record<string, unknown> = {
          chainId: native.chainId,
          isNative: true,
        };

        if (coingeckoId) {
          tokenMetadata.coingeckoId = coingeckoId;
        }

        const tokenId = await this.findOrCreateToken(
          tx,
          native.tokenSymbol,
          native.tokenName || native.tokenSymbol,
          cryptoTokenTypeId,
          native.decimals,
          tokenMetadata
        );

        const holding = await this.holdingRepository.create(
          {
            userId,
            accountId,
            tokenId,
            balance: native.balance.toString(),
            lastUpdated: new Date(),
          },
          tx
        );

        if (holding) {
          this.logInfo(
            `Created native holding ${holding.id}: ${native.balance.toString()} ${native.tokenSymbol}`
          );

          holdings.push({
            id: holding.id,
            tokenSymbol: native.tokenSymbol,
            tokenName: native.tokenSymbol,
            quantity: native.balance.toString(),
          });
        }
      } catch (error) {
        this.logError(
          `Failed to create native token holding: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Create ERC-20 token holdings
    for (const erc20Token of erc20Tokens) {
      try {
        const tokenMetadata: Record<string, unknown> = {
          chainId: erc20Token.chainId,
          contractAddress: erc20Token.address,
          isERC20: true,
        };

        // Validate token can be priced
        const validation = await this.pricingService.canTokenBePriced(
          {
            symbol: erc20Token.symbol,
            name: erc20Token.name,
            metadata: tokenMetadata,
            typeCode: 'crypto',
          },
          'USD'
        );

        if (!validation.canBePriced) {
          this.logWarning(`Skipping unpriceable token ${erc20Token.symbol} - ${validation.reason}`);
          continue;
        }

        this.logInfo(`Token ${erc20Token.symbol} can be priced via ${validation.provider}`);

        const tokenId = await this.findOrCreateToken(
          tx,
          erc20Token.symbol,
          erc20Token.name,
          cryptoTokenTypeId,
          erc20Token.decimals,
          tokenMetadata
        );

        const holding = await this.holdingRepository.create(
          {
            userId,
            accountId,
            tokenId,
            balance: erc20Token.balance.toString(),
            lastUpdated: new Date(),
          },
          tx
        );

        if (holding) {
          this.logInfo(
            `Created holding ${holding.id}: ${erc20Token.balance.toString()} ${erc20Token.symbol}`
          );

          holdings.push({
            id: holding.id,
            tokenSymbol: erc20Token.symbol,
            tokenName: erc20Token.name,
            quantity: erc20Token.balance.toString(),
          });
        }
      } catch (error) {
        this.logError(
          `Failed to create ERC-20 token holding for ${erc20Token.symbol}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return holdings;
  }

  /**
   * Find or create institution
   */
  private async findOrCreateInstitution(
    chainName: string,
    institutionTypeId: string,
    tx: DatabaseTransaction
  ) {
    const existing = await this.institutionRepository.findByNameAndType(
      chainName,
      institutionTypeId,
      tx
    );

    if (existing) {
      return existing;
    }

    const institution = await this.institutionRepository.create(
      {
        name: chainName,
        typeId: institutionTypeId,
        isActive: true,
      },
      tx
    );

    this.assertExists(institution, `Failed to create institution for ${chainName}`);
    this.logInfo(`Created institution ${chainName}`);

    return institution;
  }

  /**
   * Find or create token
   */
  private async findOrCreateToken(
    tx: DatabaseTransaction,
    symbol: string,
    name: string,
    tokenTypeId: string,
    decimals: number,
    metadata: Record<string, unknown>
  ): Promise<string> {
    const existingToken = await this.tokenRepository.findBySymbol(symbol, tx);

    if (existingToken) {
      this.logInfo(`Using existing token ${symbol} (${existingToken.id})`);
      return existingToken.id;
    }

    const newToken = await this.tokenRepository.create(
      {
        symbol,
        name,
        typeId: tokenTypeId,
        decimals,
        providerMetadata: JSON.stringify(metadata),
        isActive: true,
      },
      tx
    );

    this.assertExists(newToken, `Failed to create token ${symbol}`);
    this.logInfo(`Created token ${symbol} (${newToken.id})`);

    return newToken.id;
  }

  /**
   * Helper methods
   */
  private formatAddress(address: string, startChars = 6, endChars = 4): string {
    if (address.length <= startChars + endChars) return address;
    return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
  }

  private getChainName(chainId: number): string {
    if (EVM_CHAINS[chainId]) {
      return EVM_CHAINS[chainId].name;
    }

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

  private triggerBackgroundPricing(userId: string): void {
    this.logInfo('Triggering initial pricing for imported wallet tokens...');

    this.portfolioValuationService
      .getUserPortfolioValue(userId)
      .then(() => {
        this.logInfo('Initial pricing completed for imported wallet');
      })
      .catch((error) => {
        this.logError(
          `Failed to fetch initial prices for imported wallet: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }
}
