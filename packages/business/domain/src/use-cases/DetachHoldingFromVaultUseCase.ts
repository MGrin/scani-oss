import { Container, Service } from 'typedi';
import { VaultRepository } from '../repositories/VaultRepository';
import { VaultService } from '../services/users/VaultService';

export interface DetachHoldingFromVaultInput {
  vaultId: string;
  holdingId: string;
}

@Service()
export class DetachHoldingFromVaultUseCase {
  private readonly vaultRepository = Container.get(VaultRepository);
  private readonly vaultService = Container.get(VaultService);

  async execute(input: DetachHoldingFromVaultInput, userId: string): Promise<{ success: true }> {
    const vault = await this.vaultRepository.findById(input.vaultId);
    if (!vault || vault.userId !== userId) {
      throw new Error('Vault not found');
    }

    await this.vaultRepository.detachHolding(input.vaultId, input.holdingId);
    await this.vaultService.recalculateVaultAmount(input.vaultId);

    return { success: true };
  }
}
