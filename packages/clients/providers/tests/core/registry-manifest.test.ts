import { describe, expect, test } from 'bun:test';
import type { IntegrationManifest } from '../../src/core/integration-manifest';
import { ProviderRegistry } from '../../src/core/registry';

const sampleManifest: IntegrationManifest = {
  providerKey: 'binance',
  institutionName: 'Binance',
  credentialFields: [
    { name: 'apiKey', label: 'API Key', type: 'text', sensitive: false, required: true },
    { name: 'apiSecret', label: 'API Secret', type: 'password', sensitive: true, required: true },
  ],
  instructions: {
    steps: ['Step 1', 'Step 2'],
  },
};

describe('ProviderRegistry — manifests', () => {
  test('listIntegrationManifests is empty by default', () => {
    const r = new ProviderRegistry();
    expect(r.listIntegrationManifests()).toEqual([]);
  });

  test('register slots the manifest when present on the provider', () => {
    const r = new ProviderRegistry();
    r.register({
      providerKey: 'binance',
      capabilities: ['current-balances'],
      manifest: sampleManifest,
    });
    expect(r.listIntegrationManifests()).toHaveLength(1);
    expect(r.listIntegrationManifests()[0]?.providerKey).toBe('binance');
  });

  test('register skips providers without a manifest', () => {
    const r = new ProviderRegistry();
    r.register({
      providerKey: 'coingecko',
      capabilities: ['current-price'],
    });
    expect(r.listIntegrationManifests()).toEqual([]);
  });

  test('getIntegrationManifest returns null for unknown providerKey', () => {
    const r = new ProviderRegistry();
    expect(r.getIntegrationManifest('does-not-exist')).toBeNull();
  });

  test('getIntegrationManifest returns the registered manifest by providerKey', () => {
    const r = new ProviderRegistry();
    r.register({
      providerKey: 'binance',
      capabilities: ['current-balances'],
      manifest: sampleManifest,
    });
    const found = r.getIntegrationManifest('binance');
    expect(found).not.toBeNull();
    expect(found?.institutionName).toBe('Binance');
    expect(found?.credentialFields).toHaveLength(2);
  });

  test('multiple manifests register independently and dedupe by providerKey', () => {
    const r = new ProviderRegistry();
    r.register({
      providerKey: 'binance',
      capabilities: ['current-balances'],
      manifest: sampleManifest,
    });
    r.register({
      providerKey: 'kraken',
      capabilities: ['current-balances'],
      manifest: { ...sampleManifest, providerKey: 'kraken', institutionName: 'Kraken' },
    });
    expect(r.listIntegrationManifests()).toHaveLength(2);

    // Re-registering the same providerKey overwrites — boot wires each
    // provider once, so this only matters for tests / hot-reload.
    r.register({
      providerKey: 'binance',
      capabilities: ['current-balances'],
      manifest: { ...sampleManifest, institutionName: 'Binance.US' },
    });
    expect(r.listIntegrationManifests()).toHaveLength(2);
    expect(r.getIntegrationManifest('binance')?.institutionName).toBe('Binance.US');
  });
});
