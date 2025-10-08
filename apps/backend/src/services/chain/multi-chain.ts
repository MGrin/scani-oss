/**
 * Multi-Chain Balance Service Manager
 *
 * Routes balance requests to the appropriate chain service based on address format
 * Supports EVM, Bitcoin, Tron, Solana, and 12 additional chains
 */

import { isEVMAddress } from '../../config/chains';
import {
  cosmosService,
  hederaService,
  nearService,
  polkadotService,
  rippleService,
  stellarService,
  suiService,
} from './additional-chains';
import { algorandService } from './algorand';
import { aptosService } from './aptos';
import type { TokenBalance } from './base';
import { InvalidAddressError } from './base';
import { bitcoinService } from './bitcoin';
import { bitcoinCashService } from './bitcoin-cash';
import { cardanoService } from './cardano';
import { evmChainService } from './evm';
import { litecoinService } from './litecoin';
import { solanaService } from './solana';
import { tronService } from './tron';

/**
 * Address format detection with support for all chains
 */
export function detectAddressType(
  address: string
):
  | 'evm'
  | 'bitcoin'
  | 'bitcoin-cash'
  | 'litecoin'
  | 'tron'
  | 'solana'
  | 'algorand'
  | 'aptos'
  | 'cardano'
  | 'cosmos'
  | 'hedera'
  | 'near'
  | 'polkadot'
  | 'ripple'
  | 'stellar'
  | 'sui'
  | 'unknown' {
  // EVM addresses (0x + 40 hex chars)
  if (isEVMAddress(address)) {
    return 'evm';
  }

  // Algorand addresses (58 chars, base32, uppercase)
  if (/^[A-Z2-7]{58}$/.test(address)) {
    return 'algorand';
  }

  // Aptos/Sui addresses (0x + hex, but distinguish by length)
  if (/^0x[a-fA-F0-9]{64}$/.test(address)) {
    // Sui uses exactly 64 hex chars after 0x, Aptos can be shorter
    // For now, treat 64-char 0x addresses as Sui
    return 'sui';
  }
  if (/^0x[a-fA-F0-9]{1,63}$/.test(address)) {
    return 'aptos';
  }

  // Cardano addresses (addr1 prefix, variable length)
  if (/^addr1[a-z0-9]{50,120}$/.test(address)) {
    return 'cardano';
  }

  // Cosmos addresses (cosmos1 prefix)
  if (/^cosmos1[a-z0-9]{38}$/.test(address)) {
    return 'cosmos';
  }

  // Hedera account IDs (0.0.12345 format)
  if (/^\d+\.\d+\.\d+$/.test(address)) {
    return 'hedera';
  }

  // Near Protocol (username.near or hex)
  if (/^[a-z0-9_-]+\.near$|^[a-f0-9]{64}$/.test(address)) {
    return 'near';
  }

  // Polkadot addresses (starts with 1, longer than Bitcoin - check BEFORE Bitcoin)
  if (/^1[a-zA-Z0-9]{43,47}$/.test(address)) {
    return 'polkadot';
  }

  // Ripple addresses (starts with r) - uses base58 variant
  if (/^r[a-zA-Z0-9]{24,35}$/.test(address)) {
    return 'ripple';
  }

  // Stellar addresses (starts with G) - uses base32 with uppercase + numbers
  if (/^G[A-Z0-9]{55,56}$/.test(address)) {
    return 'stellar';
  }

  // Bitcoin Cash (CashAddr or legacy)
  if (/^(bitcoincash:)?[qp][a-z0-9]{41}$/.test(address)) {
    return 'bitcoin-cash';
  }

  // Litecoin addresses (L, M, or ltc1 prefix)
  if (/^(L|M|ltc1)[a-zA-HJ-NP-Z0-9]{25,62}$/.test(address)) {
    return 'litecoin';
  }

  // Bitcoin addresses (check after Bitcoin Cash, Litecoin, and Polkadot)
  if (/^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,42}$/.test(address)) {
    return 'bitcoin';
  }

  // Tron addresses (T + 33 chars)
  if (/^T[a-zA-Z0-9]{33}$/.test(address)) {
    return 'tron';
  }

  // Solana addresses (base58, 32-44 chars, NOT starting with common prefixes)
  if (
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) &&
    !address.startsWith('T') &&
    !address.startsWith('1') &&
    !address.startsWith('L') &&
    !address.startsWith('M')
  ) {
    return 'solana';
  }

  return 'unknown';
}

/**
 * Multi-chain balance service
 * Automatically routes to the correct service based on address format
 */
export class MultiChainService {
  /**
   * Fetch balance for any supported address type
   * Automatically detects chain type and uses appropriate service
   */
  async getBalance(address: string): Promise<TokenBalance | null> {
    const addressType = detectAddressType(address);

    switch (addressType) {
      case 'evm':
        // For EVM, we need to check multiple chains
        // Return the first chain with a non-zero balance
        return null; // EVM requires chain ID, handled separately

      case 'bitcoin':
        return await bitcoinService.getNativeBalance(address, 0);

      case 'bitcoin-cash':
        return await bitcoinCashService.getNativeBalance(address, -3);

      case 'litecoin':
        return await litecoinService.getNativeBalance(address, -4);

      case 'tron':
        return await tronService.getNativeBalance(address, -1);

      case 'solana':
        return await solanaService.getNativeBalance(address, -2);

      case 'algorand':
        return await algorandService.getNativeBalance(address, -10);

      case 'aptos':
        return await aptosService.getNativeBalance(address, -11);

      case 'cardano':
        return await cardanoService.getNativeBalance(address, -5);

      case 'cosmos':
        return await cosmosService.getNativeBalance(address, -6);

      case 'hedera':
        return await hederaService.getNativeBalance(address, -7);

      case 'near':
        return await nearService.getNativeBalance(address, -8);

      case 'polkadot':
        return await polkadotService.getNativeBalance(address, -9);

      case 'ripple':
        return await rippleService.getNativeBalance(address, -12);

      case 'stellar':
        return await stellarService.getNativeBalance(address, -13);

      case 'sui':
        return await suiService.getNativeBalance(address, -14);

      default:
        throw new InvalidAddressError(0, address);
    }
  }

  /**
   * Fetch balances across all supported chains for a given address
   * Automatically detects address type and queries appropriate chains
   */
  async getAllBalances(address: string): Promise<TokenBalance[]> {
    const addressType = detectAddressType(address);
    const balances: TokenBalance[] = [];

    try {
      switch (addressType) {
        case 'evm': {
          // Query all EVM chains
          const evmBalances = await evmChainService.getBalancesAcrossChains(address);
          balances.push(...evmBalances);
          break;
        }

        case 'bitcoin': {
          const btcBalance = await bitcoinService.getNativeBalance(address, 0);
          if (btcBalance.balance.greaterThan(0)) {
            balances.push(btcBalance);
          }
          break;
        }

        case 'bitcoin-cash': {
          const bchBalance = await bitcoinCashService.getNativeBalance(address, -3);
          if (bchBalance.balance.greaterThan(0)) {
            balances.push(bchBalance);
          }
          break;
        }

        case 'litecoin': {
          const ltcBalance = await litecoinService.getNativeBalance(address, -4);
          if (ltcBalance.balance.greaterThan(0)) {
            balances.push(ltcBalance);
          }
          break;
        }

        case 'tron': {
          const trxBalance = await tronService.getNativeBalance(address, -1);
          if (trxBalance.balance.greaterThan(0)) {
            balances.push(trxBalance);
          }
          break;
        }

        case 'solana': {
          const solBalance = await solanaService.getNativeBalance(address, -2);
          if (solBalance.balance.greaterThan(0)) {
            balances.push(solBalance);
          }
          break;
        }

        case 'algorand': {
          const algoBalance = await algorandService.getNativeBalance(address, -10);
          if (algoBalance.balance.greaterThan(0)) {
            balances.push(algoBalance);
          }
          break;
        }

        case 'aptos': {
          const aptBalance = await aptosService.getNativeBalance(address, -11);
          if (aptBalance.balance.greaterThan(0)) {
            balances.push(aptBalance);
          }
          break;
        }

        case 'cardano': {
          const adaBalance = await cardanoService.getNativeBalance(address, -5);
          if (adaBalance.balance.greaterThan(0)) {
            balances.push(adaBalance);
          }
          break;
        }

        case 'cosmos': {
          const atomBalance = await cosmosService.getNativeBalance(address, -6);
          if (atomBalance.balance.greaterThan(0)) {
            balances.push(atomBalance);
          }
          break;
        }

        case 'hedera': {
          const hbarBalance = await hederaService.getNativeBalance(address, -7);
          if (hbarBalance.balance.greaterThan(0)) {
            balances.push(hbarBalance);
          }
          break;
        }

        case 'near': {
          const nearBalance = await nearService.getNativeBalance(address, -8);
          if (nearBalance.balance.greaterThan(0)) {
            balances.push(nearBalance);
          }
          break;
        }

        case 'polkadot': {
          const dotBalance = await polkadotService.getNativeBalance(address, -9);
          if (dotBalance.balance.greaterThan(0)) {
            balances.push(dotBalance);
          }
          break;
        }

        case 'ripple': {
          const xrpBalance = await rippleService.getNativeBalance(address, -12);
          if (xrpBalance.balance.greaterThan(0)) {
            balances.push(xrpBalance);
          }
          break;
        }

        case 'stellar': {
          const xlmBalance = await stellarService.getNativeBalance(address, -13);
          if (xlmBalance.balance.greaterThan(0)) {
            balances.push(xlmBalance);
          }
          break;
        }

        case 'sui': {
          const suiBalance = await suiService.getNativeBalance(address, -14);
          if (suiBalance.balance.greaterThan(0)) {
            balances.push(suiBalance);
          }
          break;
        }

        default:
          throw new InvalidAddressError(0, address);
      }
    } catch (error) {
      // Log error but don't fail the entire operation
      console.error(`Failed to fetch balance for ${address}:`, error);
    }

    return balances;
  }

  /**
   * Check if an address is supported by any chain service
   */
  isSupportedAddress(address: string): boolean {
    return detectAddressType(address) !== 'unknown';
  }

  /**
   * Get the chain type for an address
   */
  getChainType(address: string): string {
    return detectAddressType(address);
  }
}

// Singleton instance
export const multiChainService = new MultiChainService();
