/**
 * Additional Chain Services (Stub Implementations)
 *
 * These services provide basic structure for chains that need API keys
 * or have complex integration requirements. They return zero balance
 * but can be enhanced with full API integration later.
 *
 * Chains included:
 * - Cosmos (ATOM) - Chain ID: -6
 * - Hedera (HBAR) - Chain ID: -7
 * - Near Protocol (NEAR) - Chain ID: -8
 * - Polkadot (DOT) - Chain ID: -9
 * - Ripple/XRP (XRP) - Chain ID: -12
 * - Stellar (XLM) - Chain ID: -13
 * - Sui (SUI) - Chain ID: -14
 */

import Decimal from 'decimal.js';
import { logger } from '../../../utils/logger';
import { type ChainBalanceService, InvalidAddressError, type TokenBalance } from './base';

// Cosmos Service (ATOM)
export class CosmosService implements ChainBalanceService {
  private readonly CHAIN_ID = -6;

  getServiceName(): string {
    return 'CosmosService';
  }

  supportsChain(chainId: number): boolean {
    return chainId === this.CHAIN_ID;
  }

  async getNativeBalance(address: string, chainId: number): Promise<TokenBalance> {
    // Cosmos addresses start with "cosmos1"
    if (!/^cosmos1[a-z0-9]{38}$/.test(address)) {
      throw new InvalidAddressError(chainId, address);
    }

    logger.info(`Cosmos balance check for ${address} - returning 0 (stub implementation)`);

    return {
      address,
      chainId: this.CHAIN_ID,
      chainName: 'Cosmos',
      tokenSymbol: 'ATOM',
      balance: new Decimal(0),
      decimals: 6,
    };
  }
}

// Hedera Service (HBAR)
export class HederaService implements ChainBalanceService {
  private readonly CHAIN_ID = -7;

  getServiceName(): string {
    return 'HederaService';
  }

  supportsChain(chainId: number): boolean {
    return chainId === this.CHAIN_ID;
  }

  async getNativeBalance(address: string, chainId: number): Promise<TokenBalance> {
    // Hedera uses account IDs like "0.0.123456"
    if (!/^\d+\.\d+\.\d+$/.test(address)) {
      throw new InvalidAddressError(chainId, address);
    }

    logger.info(`Hedera balance check for ${address} - returning 0 (stub implementation)`);

    return {
      address,
      chainId: this.CHAIN_ID,
      chainName: 'Hedera',
      tokenSymbol: 'HBAR',
      balance: new Decimal(0),
      decimals: 8,
    };
  }
}

// Near Protocol Service (NEAR)
export class NearService implements ChainBalanceService {
  private readonly CHAIN_ID = -8;

  getServiceName(): string {
    return 'NearService';
  }

  supportsChain(chainId: number): boolean {
    return chainId === this.CHAIN_ID;
  }

  async getNativeBalance(address: string, chainId: number): Promise<TokenBalance> {
    // Near addresses can be account names (username.near) or hex
    if (!/^[a-z0-9_-]+\.near$|^[a-f0-9]{64}$/.test(address)) {
      throw new InvalidAddressError(chainId, address);
    }

    logger.info(`Near Protocol balance check for ${address} - returning 0 (stub implementation)`);

    return {
      address,
      chainId: this.CHAIN_ID,
      chainName: 'Near Protocol',
      tokenSymbol: 'NEAR',
      balance: new Decimal(0),
      decimals: 24,
    };
  }
}

// Polkadot Service (DOT)
export class PolkadotService implements ChainBalanceService {
  private readonly CHAIN_ID = -9;

  getServiceName(): string {
    return 'PolkadotService';
  }

  supportsChain(chainId: number): boolean {
    return chainId === this.CHAIN_ID;
  }

  async getNativeBalance(address: string, chainId: number): Promise<TokenBalance> {
    // Polkadot addresses start with "1"
    if (!/^1[a-zA-Z0-9]{47}$/.test(address)) {
      throw new InvalidAddressError(chainId, address);
    }

    logger.info(`Polkadot balance check for ${address} - returning 0 (stub implementation)`);

    return {
      address,
      chainId: this.CHAIN_ID,
      chainName: 'Polkadot',
      tokenSymbol: 'DOT',
      balance: new Decimal(0),
      decimals: 10,
    };
  }
}

// Ripple/XRP Service
export class RippleService implements ChainBalanceService {
  private readonly CHAIN_ID = -12;

  getServiceName(): string {
    return 'RippleService';
  }

  supportsChain(chainId: number): boolean {
    return chainId === this.CHAIN_ID;
  }

  async getNativeBalance(address: string, chainId: number): Promise<TokenBalance> {
    // Ripple addresses start with "r"
    if (!/^r[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(address)) {
      throw new InvalidAddressError(chainId, address);
    }

    logger.info(`Ripple balance check for ${address} - returning 0 (stub implementation)`);

    return {
      address,
      chainId: this.CHAIN_ID,
      chainName: 'Ripple',
      tokenSymbol: 'XRP',
      balance: new Decimal(0),
      decimals: 6,
    };
  }
}

// Stellar Service (XLM)
export class StellarService implements ChainBalanceService {
  private readonly CHAIN_ID = -13;

  getServiceName(): string {
    return 'StellarService';
  }

  supportsChain(chainId: number): boolean {
    return chainId === this.CHAIN_ID;
  }

  async getNativeBalance(address: string, chainId: number): Promise<TokenBalance> {
    // Stellar addresses start with "G"
    if (!/^G[A-Z2-7]{55}$/.test(address)) {
      throw new InvalidAddressError(chainId, address);
    }

    logger.info(`Stellar balance check for ${address} - returning 0 (stub implementation)`);

    return {
      address,
      chainId: this.CHAIN_ID,
      chainName: 'Stellar',
      tokenSymbol: 'XLM',
      balance: new Decimal(0),
      decimals: 7,
    };
  }
}

// Sui Service
export class SuiService implements ChainBalanceService {
  private readonly CHAIN_ID = -14;

  getServiceName(): string {
    return 'SuiService';
  }

  supportsChain(chainId: number): boolean {
    return chainId === this.CHAIN_ID;
  }

  async getNativeBalance(address: string, chainId: number): Promise<TokenBalance> {
    // Sui addresses are hex with 0x prefix
    if (!/^0x[a-fA-F0-9]{64}$/.test(address)) {
      throw new InvalidAddressError(chainId, address);
    }

    logger.info(`Sui balance check for ${address} - returning 0 (stub implementation)`);

    return {
      address,
      chainId: this.CHAIN_ID,
      chainName: 'Sui',
      tokenSymbol: 'SUI',
      balance: new Decimal(0),
      decimals: 9,
    };
  }
}

// Singleton instances
export const cosmosService = new CosmosService();
export const hederaService = new HederaService();
export const nearService = new NearService();
export const polkadotService = new PolkadotService();
export const rippleService = new RippleService();
export const stellarService = new StellarService();
export const suiService = new SuiService();
