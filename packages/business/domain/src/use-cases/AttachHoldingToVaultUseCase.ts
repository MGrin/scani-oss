import { Container, Service } from 'typedi';
import { HoldingRepository } from '../repositories/HoldingRepository';
import { VaultRepository } from '../repositories/VaultRepository';
import { VaultService } from '../services/users/VaultService';

export interface AttachHoldingToVaultInput {
  vaultId: string;
  holdingId: string;
  percentage: number;
}

@Service()
export class AttachHoldingToVaultUseCase {
  private readonly vaultRepository = Container.get(VaultRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly vaultService = Container.get(VaultService);

  async execute(input: AttachHoldingToVaultInput, userId: string) {
    const vault = await this.vaultRepository.findById(input.vaultId);
    if (!vault || vault.userId !== userId) {
      throw new Error('Vault not found');
    }

    const holding = await this.holdingRepository.findByIdVisible(input.holdingId);
    if (!holding || holding.userId !== userId) {
      throw new Error('Holding not found');
    }

    const result = await this.vaultRepository.attachHolding(
      input.vaultId,
      input.holdingId,
      input.percentage
    );

    await this.vaultService.recalculateVaultAmount(input.vaultId);

    return result;
  }
}
