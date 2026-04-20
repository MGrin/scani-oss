import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { IntegrationManager } from './IntegrationManager';

// Smoke tests for the IntegrationManager, focusing on the parts that don't
// require network access. The goal here is to pin the Phase 2 consolidation:
// blockchain service wiring must happen eagerly in the constructor (no
// async init, no DB dependency) so `detectWalletChains` works reliably
// the moment the app boots. A regression that moves the init elsewhere
// would manifest as 0 chainIds before anything warms the registry.

describe('IntegrationManager (offline)', () => {
  test('constructor registers the major chains without DB or network', () => {
    const manager = Container.get(IntegrationManager);
    const chainIds = manager.getActiveChainIds();
    // At minimum, the mainstream chains the wallet-import UI surfaces.
    expect(chainIds.length).toBeGreaterThan(0);
    // Ethereum mainnet (1) is the benchmark — used by ENS, every EVM flow.
    expect(chainIds.map(String)).toContain('1');
  });

  test('getBlockchainService returns undefined for unknown chainIds', () => {
    const manager = Container.get(IntegrationManager);
    expect(manager.getBlockchainService('this-chain-does-not-exist')).toBeUndefined();
  });

  test('getBlockchainService returns a defined service for Ethereum mainnet', () => {
    const manager = Container.get(IntegrationManager);
    const ethereum = manager.getBlockchainService(1);
    expect(ethereum).toBeDefined();
    // Every IBlockchainService must expose these primitives — interface contract.
    expect(typeof ethereum?.isValidAddress).toBe('function');
    expect(typeof ethereum?.getChainName).toBe('function');
  });

  test('getAllSupportedChains returns a stable non-empty list (UI picker invariant)', () => {
    const manager = Container.get(IntegrationManager);
    const chains = manager.getAllSupportedChains();
    expect(chains.length).toBeGreaterThan(0);
    // Every chain config must carry at least these fields — used by
    // frontend chain pickers + backend chain-detection code.
    for (const c of chains) {
      expect(typeof c.chainId).not.toBe('undefined');
      expect(typeof c.name).toBe('string');
    }
  });

  test('resolveEnsName returns null for non-Ethereum-looking addresses (never throws)', async () => {
    // Documented contract: ENS resolution must not throw on garbage input.
    // A regression that let errors escape here would crash wallet-import
    // whenever a non-0x address lands in the resolver.
    const manager = Container.get(IntegrationManager);
    expect(await manager.resolveEnsName('not-a-real-address')).toBeNull();
  });
});
