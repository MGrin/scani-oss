import type { VaultHoldingDetail, VaultWithProgress } from '@scani/shared';
import { Decimal } from '@scani/shared';
import { Container, Service } from 'typedi';
import { TokenRepository } from '../../repositories/TokenRepository';
import { VaultRepository } from '../../repositories/VaultRepository';
import { BaseService } from '../BaseService';
import { PriceReader } from '../pricing/PriceReader';

/**
 * VaultService
 *
 * Handles vault business logic including:
 * - Computing current vault amounts from attached holdings
 * - Recalculating vault amounts when holdings/prices change
 * - Building vault progress data for display
 *
 * A holding is priced in the vault's currency by `PriceReader`, from stored
 * readings: a vault never asks a provider.
 */
@Service()
export class VaultService extends BaseService {
  private readonly vaultRepository = Container.get(VaultRepository);
  private readonly tokenRepository = Container.get(TokenRepository);
  private readonly priceReader = Container.get(PriceReader);

  constructor() {
    super('VaultService');
  }

  /**
   * Recalculate the currentAmount for a single vault.
   * For each attached holding: balance * price_in_vault_currency * (percentage / 100)
   */
  async recalculateVaultAmount(vaultId: string): Promise<void> {
    try {
      const amount = await this.amountOf(vaultId);
      if (amount === null) return;

      await this.vaultRepository.updateCurrentAmount(vaultId, amount);

      this.logDebug('Vault amount recalculated', { vaultId, currentAmount: amount });
    } catch (error) {
      this.logError('Failed to recalculate vault amount', {
        vaultId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The amount `recalculateVaultAmount` stores, computed and not written; null
   * when the vault or its currency is gone.
   */
  async amountOf(vaultId: string): Promise<string | null> {
    const vault = await this.vaultRepository.findById(vaultId);
    if (!vault) {
      this.logDebug('Vault not found for recalculation', { vaultId });
      return null;
    }

    const vaultCurrency = await this.tokenRepository.findById(vault.currencyId);
    if (!vaultCurrency) {
      this.logWarning('Vault currency not found', { vaultId, currencyId: vault.currencyId });
      return null;
    }

    const vaultHoldingsData = await this.vaultRepository.findVaultHoldings(vaultId);
    const prices = await this.pricesIn(
      vaultCurrency.id,
      vaultHoldingsData.map(({ token }) => token.id)
    );

    let total = new Decimal(0);

    for (const { vaultHolding, holding, token } of vaultHoldingsData) {
      const balance = new Decimal(holding.balance);
      if (balance.isZero()) continue;

      const price = prices.get(token.id) ?? null;

      // Unpriceable holding: skip from the vault total rather than
      // treat it as worth zero. A partial vault total is more honest
      // than a silently understated one.
      if (price === null) {
        this.logWarning('Skipping unpriceable holding from vault total', {
          vaultId,
          tokenSymbol: token.symbol,
          holdingId: holding.id,
          holdingLabel: holding.label,
        });
        continue;
      }

      const holdingValue = balance.times(new Decimal(price));
      total = total.plus(holdingValue.times(new Decimal(vaultHolding.percentage)).dividedBy(100));
    }

    return total.toFixed();
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
    // The same prices `recalculateVaultAmount` reads, so the detail view
    // matches the stored aggregate.
    const prices = await this.pricesIn(
      vaultCurrency.id,
      vaultHoldingsData.map(({ token }) => token.id)
    );

    const holdingDetails: VaultHoldingDetail[] = [];

    for (const { vaultHolding, holding, token, account, institution } of vaultHoldingsData) {
      const balance = new Decimal(holding.balance);
      const price = prices.get(token.id) ?? null;

      const holdingValue = price !== null ? balance.times(new Decimal(price)) : null;
      const attributedValue = holdingValue
        ? holdingValue.times(new Decimal(vaultHolding.percentage)).dividedBy(100)
        : null;

      holdingDetails.push({
        holdingId: holding.id,
        holdingLabel: holding.label,
        percentage: vaultHolding.percentage,
        tokenSymbol: token.symbol,
        tokenName: token.name,
        tokenIconUrl: token.iconUrl,
        accountName: account.name,
        institutionName: institution.name,
        holdingBalance: holding.balance,
        holdingValue: holdingValue?.toFixed() ?? null,
        attributedValue: attributedValue?.toFixed() ?? null,
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

  /** Each token's price in the vault's currency now, absent when unpriced. */
  private async pricesIn(
    currencyId: string,
    tokenIds: readonly string[]
  ): Promise<Map<string, string>> {
    const answers = await this.priceReader.at([...new Set(tokenIds)], currencyId, new Date());
    const prices = new Map<string, string>();
    for (const [tokenId, answer] of answers) {
      if (answer !== null) prices.set(tokenId, answer.price.toString());
    }
    return prices;
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
