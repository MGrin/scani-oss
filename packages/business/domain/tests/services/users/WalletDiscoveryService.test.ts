process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { ETHERSCAN_CHAINS } from '@scani/providers/providers/etherscan';
import { Container } from 'typedi';
import { WalletDiscoveryService } from '../../../src/services/users/WalletDiscoveryService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

const GENESIS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';

/**
 * A registry that answers `bitcoin` with a validator we control and every
 * other chain with nothing, so a test asserts one probe rather than the
 * whole catalog.
 */
function serviceWithBitcoinProbe(hasActivity: () => Promise<boolean>): WalletDiscoveryService {
  const validator = {
    providerKey: 'test-bitcoin',
    capabilities: ['address-validator'] as const,
    canValidate: (code: string) => code === 'bitcoin',
    isValidAddress: (_address: string, code: string) => code === 'bitcoin',
    hasActivity,
  };
  const registry = {
    getAllAddressValidators: () => [validator],
    getAddressValidator: (code: string) => (code === 'bitcoin' ? validator : null),
  };
  Container.set(ProviderRegistry, registry);
  const instance = new WalletDiscoveryService();
  Container.set(WalletDiscoveryService, instance);
  return instance;
}

describe('WalletDiscoveryService.detectWalletChains', () => {
  test('a chain that answers "no history" produces no failure', async () => {
    const service = serviceWithBitcoinProbe(async () => false);
    const result = await service.detectWalletChains(GENESIS);
    expect(result.detected).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  test('a chain that answers "has history" is detected', async () => {
    const service = serviceWithBitcoinProbe(async () => true);
    const result = await service.detectWalletChains(GENESIS);
    expect(result.detected).toEqual(['bitcoin']);
    expect(result.failures).toEqual([]);
  });

  test('a probe that could not be completed is reported, not swallowed', async () => {
    // The exact shape of the SC-490 failure: blockchain.info 429s after a
    // burst, and the old code logged it at debug and returned `false`, so
    // the caller saw a wallet with no Bitcoin history.
    const service = serviceWithBitcoinProbe(async () => {
      throw new Error('blockchain.info: HTTP 429 for 1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
    });
    const result = await service.detectWalletChains(GENESIS);

    expect(result.detected).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.institutionCode).toBe('bitcoin');
    expect(result.failures[0]?.chainName).toBe('Bitcoin');
    expect(result.failures[0]?.error).toContain('HTTP 429');
  });

  test('"nothing found" and "could not check" are different answers', async () => {
    const empty = await serviceWithBitcoinProbe(async () => false).detectWalletChains(GENESIS);
    const broken = await serviceWithBitcoinProbe(async () => {
      throw new Error('upstream exploded');
    }).detectWalletChains(GENESIS);

    expect(empty.detected).toEqual(broken.detected);
    expect(empty.failures).not.toEqual(broken.failures);
  });
});

// The UI catalog and the detection probe set are a second copy of the
// Etherscan provider's chain list. A chain kept here after the provider drops
// it is offered in the picker and probed on every import, and fails every
// time (SC-1524).
describe('WalletDiscoveryService EVM catalog', () => {
  const etherscanIds = ETHERSCAN_CHAINS.map((c) => c.chainId).sort((a, b) => a - b);
  const etherscanCodes = ETHERSCAN_CHAINS.map((c) => c.institutionCode).sort();

  test('lists exactly the chains the Etherscan provider serves', () => {
    const listed = new WalletDiscoveryService()
      .getAllSupportedChains()
      .filter((c) => c.type === 'evm')
      .map((c) => Number(c.chainId))
      .sort((a, b) => a - b);
    expect(listed).toEqual(etherscanIds);
  });

  test('probes exactly the Etherscan institution codes', async () => {
    const asked: string[] = [];
    Container.set(ProviderRegistry, {
      getAllAddressValidators: () => [],
      getAddressValidator: (code: string) => {
        asked.push(code);
        return null;
      },
    });
    await new WalletDiscoveryService().detectWalletChains(
      '0x0000000000000000000000000000000000000001'
    );
    const nonEvm = new Set(['bitcoin', 'solana', 'tron', 'ton']);
    expect(asked.filter((c) => !nonEvm.has(c)).sort()).toEqual(etherscanCodes);
  });
});
