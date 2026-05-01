import type { VaultHoldingDetail, VaultWithProgress } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { TokenPriceRepository } from '../../repositories/TokenPriceRepository';
import { TokenRepository } from '../../repositories/TokenRepository';
import { VaultRepository } from '../../repositories/VaultRepository';
import { BaseService } from '../BaseService';
import { PricingService } from '../pricing/PricingService';

/**
 * VaultService
 *
 * Handles vault business logic including:
 * - Computing current vault amounts from attached holdings
 * - Recalculating vault amounts when holdings/prices change
 * - Building vault progress data for display
 */
@Service()
export class VaultService extends BaseService {
  private readonly vaultRepository = Container.get(VaultRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly tokenPriceRepository = Container.get(TokenPriceRepository);
  private readonly pricingService = Container.get(PricingService);

  constructor() {
    super('VaultService');
  }

  /**
   * Recalculate the currentAmount for a single vault.
   * For each attached holding: balance * price_in_vault_currency * (percentage / 100)
   */
  async recalculateVaultAmount(vaultId: string): Promise<void> {
    try {
      const vault = await this.vaultRepository.findById(vaultId);
      if (!vault) {
        this.logDebug('Vault not found for recalculation', { vaultId });
        return;
      }

      const vaultCurrency = await this.tokenRepository.findById(vault.currencyId);
      if (!vaultCurrency) {
        this.logWarning('Vault currency not found', { vaultId, currencyId: vault.currencyId });
        return;
      }

      const vaultHoldingsData = await this.vaultRepository.findVaultHoldings(vaultId);

      let total = new Decimal(0);

      for (const { vaultHolding, holding, token } of vaultHoldingsData) {
        const balance = new Decimal(holding.balance);
        if (balance.isZero()) continue;

        let price: string;
        if (token.id === vaultCurrency.id) {
          // Token is same as vault currency, price is 1
          price = '1';
        } else {
          // Get latest price in vault currency
          const latestPrice = await this.tokenPriceRepository.findLatestPrice(
            token.id,
            vaultCurrency.id
          );

          if (latestPrice) {
            price = latestPrice.price;
          } else {
            // Try to fetch via pricing service
            try {
              price = await this.pricingService.getTokenPrice(
                token,
                vaultCurrency.symbol,
                new Date()
              );
            } catch {
              price = '0';
            }
          }
        }

        const holdingValue = balance.times(new Decimal(price));
        const attributedValue = holdingValue
          .times(new Decimal(vaultHolding.percentage))
          .dividedBy(100);
        total = total.plus(attributedValue);
      }

      await this.vaultRepository.updateCurrentAmount(vaultId, total.toFixed());

      this.logDebug('Vault amount recalculated', {
        vaultId,
        currentAmount: total.toFixed(),
      });
    } catch (error) {
      this.logError('Failed to recalculate vault amount', {
        vaultId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Recalculate all vaults that reference a specific holding.
   * Called when a holding's balance or price changes.
   */
  async recalculateVaultsForHolding(holdingId: string): Promise<void> {
    try {
      const vaultRefs = await this.vaultRepository.findVaultsByHoldingId(holdingId);
      if (vaultRefs.length === 0) return;

      const uniqueVaultIds = [...new Set(vaultRefs.map((ref) => ref.vault.id))];

      this.logDebug('Recalculating vaults for holding', {
        holdingId,
        vaultCount: uniqueVaultIds.length,
      });

      await Promise.all(uniqueVaultIds.map((vaultId) => this.recalculateVaultAmount(vaultId)));
    } catch (error) {
      this.logError('Failed to recalculate vaults for holding', {
        holdingId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Recalculate all vaults that reference any holding of a specific token.
   * Called when a token's price changes (e.g., from cron pricing job).
   * Optimized to recalculate each vault only once even if multiple holdings of that token are attached.
   */
  async recalculateVaultsForToken(tokenId: string, holdingIds: string[]): Promise<void> {
    try {
      const allVaultIds = new Set<string>();

      for (const holdingId of holdingIds) {
        const vaultRefs = await this.vaultRepository.findVaultsByHoldingId(holdingId);
        for (const ref of vaultRefs) {
          allVaultIds.add(ref.vault.id);
        }
      }

      if (allVaultIds.size === 0) return;

      this.logDebug('Recalculating vaults for token price change', {
        tokenId,
        holdingsCount: holdingIds.length,
        vaultCount: allVaultIds.size,
      });

      await Promise.all(
        Array.from(allVaultIds).map((vaultId) => this.recalculateVaultAmount(vaultId))
      );
    } catch (error) {
      this.logError('Failed to recalculate vaults for token', {
        tokenId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get a single vault with full progress data and holding details.
   */
  async getVaultWithProgress(vaultId: string): Promise<VaultWithProgress | null> {
    const vault = await this.vaultRepository.findById(vaultId);
    if (!vault) return null;

    const vaultCurrency = await this.tokenRepository.findById(vault.currencyId);
    if (!vaultCurrency) return null;

    const vaultHoldingsData = await this.vaultRepository.findVaultHoldings(vaultId);

    const holdingDetails: VaultHoldingDetail[] = [];

    for (const { vaultHolding, holding, token, account, institution } of vaultHoldingsData) {
      const balance = new Decimal(holding.balance);
      let price = '0';

      if (token.id === vaultCurrency.id) {
        price = '1';
      } else {
        // Strict lookup first; if it misses, fall back to PricingService
        // so custom tokens priced in a different fiat are converted to
        // the vault's currency. This mirrors `recalculateVaultAmount`
        // so the detail view matches the stored aggregate.
        const latestPrice = await this.tokenPriceRepository.findLatestPrice(
          token.id,
          vaultCurrency.id
        );
        if (latestPrice) {
          price = latestPrice.price;
        } else {
          try {
            price = await this.pricingService.getTokenPrice(
              token,
              vaultCurrency.symbol,
              new Date()
            );
          } catch {
            price = '0';
          }
        }
      }

      const holdingValue = balance.times(new Decimal(price));
      const attributedValue = holdingValue
        .times(new Decimal(vaultHolding.percentage))
        .dividedBy(100);

      holdingDetails.push({
        holdingId: holding.id,
        percentage: vaultHolding.percentage,
        tokenSymbol: token.symbol,
        tokenName: token.name,
        tokenIconUrl: token.iconUrl,
        accountName: account.name,
        institutionName: institution.name,
        holdingBalance: holding.balance,
        holdingValue: holdingValue.toFixed(),
        attributedValue: attributedValue.toFixed(),
      });
    }

    const targetAmount = new Decimal(vault.targetAmount);
    const currentAmount = new Decimal(vault.currentAmount);
    const progress = targetAmount.isZero()
      ? 0
      : currentAmount.dividedBy(targetAmount).times(100).toDecimalPlaces(2).toNumber();

    return {
      id: vault.id,
      userId: vault.userId,
      name: vault.name,
      description: vault.description,
      targetAmount: vault.targetAmount,
      currencyId: vault.currencyId,
      currencySymbol: vaultCurrency.symbol,
      currencyName: vaultCurrency.name,
      currentAmount: vault.currentAmount,
      progress,
      color: vault.color,
      iconName: vault.iconName,
      isActive: vault.isActive,
      holdingsCount: holdingDetails.length,
      holdings: holdingDetails,
      createdAt: vault.createdAt.toISOString(),
      updatedAt: vault.updatedAt.toISOString(),
    };
  }

  /**
   * Get all vaults for a user with progress data.
   */
  async getVaultsForUser(userId: string): Promise<VaultWithProgress[]> {
    const vaultsWithCounts = await this.vaultRepository.findByUserWithHoldingsCounts(userId);

    const results: VaultWithProgress[] = [];

    for (const vault of vaultsWithCounts) {
      const vaultCurrency = await this.tokenRepository.findById(vault.currencyId);
      if (!vaultCurrency) continue;

      const targetAmount = new Decimal(vault.targetAmount);
      const currentAmount = new Decimal(vault.currentAmount);
      const progress = targetAmount.isZero()
        ? 0
        : currentAmount.dividedBy(targetAmount).times(100).toDecimalPlaces(2).toNumber();

      results.push({
        id: vault.id,
        userId: vault.userId,
        name: vault.name,
        description: vault.description,
        targetAmount: vault.targetAmount,
        currencyId: vault.currencyId,
        currencySymbol: vaultCurrency.symbol,
        currencyName: vaultCurrency.name,
        currentAmount: vault.currentAmount,
        progress,
        color: vault.color,
        iconName: vault.iconName,
        isActive: vault.isActive,
        holdingsCount: vault.holdingsCount,
        holdings: [], // Not loaded for list view, use getVaultWithProgress for detail
        createdAt: vault.createdAt.toISOString(),
        updatedAt: vault.updatedAt.toISOString(),
      });
    }

    return results;
  }
}
