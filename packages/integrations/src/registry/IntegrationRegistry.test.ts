import { beforeEach, describe, expect, it } from 'bun:test';
import { ScaniIntegration } from '../base';
import type {
  FetchAccountsResult,
  FetchHoldingsResult,
  IntegrationHolding,
  IntegrationStatus,
  TokenMappingResult,
} from '../types';
import { IntegrationAuthType } from '../types';
import type { IntegrationConfig } from './IntegrationRegistry';
import { integrationRegistry } from './IntegrationRegistry';

class MockIntegration extends ScaniIntegration {
  async fetchAccounts(): Promise<FetchAccountsResult> {
    return { accounts: [], total: 0 };
  }
  async fetchHoldings(): Promise<FetchHoldingsResult> {
    return { holdings: [], total: 0, accountId: '', timestamp: new Date() };
  }
  async mapToken(_h: IntegrationHolding): Promise<TokenMappingResult> {
    return { token: { symbol: '', name: '', typeId: '' }, isNew: true, confidence: 1 };
  }
  async validateCredentials(): Promise<boolean> {
    return true;
  }
  async checkHealth(): Promise<IntegrationStatus> {
    return { isHealthy: true };
  }
  async refreshAuthentication(): Promise<Record<string, unknown>> {
    return {};
  }
}

function makeConfig(
  id: string,
  name: string,
  type: 'exchange' | 'broker' = 'exchange'
): IntegrationConfig {
  return {
    institutionId: id,
    type,
    authType: 'api_key',
    name,
    createIntegration: () =>
      new MockIntegration(id, { type: IntegrationAuthType.API_KEY, apiKey: '', baseUrl: '' }),
  };
}

describe('integrationRegistry (singleton)', () => {
  beforeEach(() => {
    integrationRegistry.clear();
  });

  it('should register and retrieve an integration', () => {
    const config = makeConfig('test-1', 'Test Exchange');
    integrationRegistry.register(config);
    expect(integrationRegistry.get('test-1')).toBe(config);
  });

  it('should return null for unknown integration', () => {
    expect(integrationRegistry.get('nonexistent')).toBeNull();
  });

  it('should create integration instance', () => {
    integrationRegistry.register(makeConfig('test-2', 'Test'));
    const integration = integrationRegistry.createIntegration('test-2');
    expect(integration).toBeInstanceOf(MockIntegration);
  });

  it('should return null when creating unknown integration', () => {
    expect(integrationRegistry.createIntegration('nonexistent')).toBeNull();
  });

  it('should overwrite on duplicate registration', () => {
    integrationRegistry.register(makeConfig('dup', 'First'));
    integrationRegistry.register(makeConfig('dup', 'Second'));
    expect(integrationRegistry.get('dup')?.name).toBe('Second');
  });

  it('should list all integrations', () => {
    integrationRegistry.register(makeConfig('a', 'A'));
    integrationRegistry.register(makeConfig('b', 'B'));
    expect(integrationRegistry.getAll()).toHaveLength(2);
  });

  it('should filter by type', () => {
    integrationRegistry.register(makeConfig('ex1', 'Exchange 1', 'exchange'));
    integrationRegistry.register(makeConfig('br1', 'Broker 1', 'broker'));
    integrationRegistry.register(makeConfig('ex2', 'Exchange 2', 'exchange'));

    expect(integrationRegistry.getByType('exchange')).toHaveLength(2);
    expect(integrationRegistry.getByType('broker')).toHaveLength(1);
    expect(integrationRegistry.getByType('bank')).toHaveLength(0);
  });

  it('should report correct size', () => {
    expect(integrationRegistry.size()).toBe(0);
    integrationRegistry.register(makeConfig('x', 'X'));
    expect(integrationRegistry.size()).toBe(1);
  });

  it('should check has()', () => {
    integrationRegistry.register(makeConfig('exists', 'Exists'));
    expect(integrationRegistry.has('exists')).toBe(true);
    expect(integrationRegistry.has('nope')).toBe(false);
  });

  it('should clear all registrations', () => {
    integrationRegistry.register(makeConfig('a', 'A'));
    integrationRegistry.register(makeConfig('b', 'B'));
    integrationRegistry.clear();
    expect(integrationRegistry.size()).toBe(0);
  });
});
