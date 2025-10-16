import { Container, Service } from 'typedi';
import { ImportWalletAddressUseCase } from '../use-cases/ImportWalletAddressUseCase';
import { BaseService } from './BaseService';

/**
 * Input DTO for wallet import
 */
export interface ImportWalletDto {
  walletAddress: string;
  accountName?: string;
}

/**
 * Response DTO for wallet import
 */
export interface WalletImportResult {
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
 * WalletService
 *
 * Handles crypto wallet import by delegating to ImportWalletAddressUseCase.
 *
 * This service layer provides a simple interface for the router/presentation layer
 * while the actual business logic is implemented in the use case.
 */
@Service()
export class WalletService extends BaseService {
  private readonly importWalletAddressUseCase = Container.get(ImportWalletAddressUseCase);

  constructor() {
    super('WalletService');
  }

  /**
   * Import wallet address - creates accounts and holdings for all chains with balances
   *
   * Delegates to ImportWalletAddressUseCase for all business logic.
   */
  async importWalletAddress(data: ImportWalletDto, userId: string): Promise<WalletImportResult> {
    return await this.importWalletAddressUseCase.execute(data, userId);
  }
}
