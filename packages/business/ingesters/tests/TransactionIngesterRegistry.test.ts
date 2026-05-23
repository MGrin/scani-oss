import { describe, expect, it } from 'bun:test';
import {
  type IngesterResult,
  type TransactionIngester,
  TransactionIngesterRegistry,
} from '../src/TransactionIngester';

// The registry has no DI deps — instantiate directly so the tests don't
// need reflect-metadata preloaded. (Worker bootstrap goes through typedi.)
const makeStub = (source: string): TransactionIngester => ({
  source,
  async ingestForAccount(): Promise<IngesterResult> {
    return {
      transactions: [],
      observations: [],
      coverage: {
        firstEventAt: null,
        lastEventAt: null,
        hasCompleteTxHistory: false,
        sourceTag: source,
      },
      warnings: [],
    };
  },
});

describe('TransactionIngesterRegistry', () => {
  it('registers and retrieves an ingester by source', () => {
    const registry = new TransactionIngesterRegistry();
    const a = makeStub('etherscan');
    registry.register(a);
    expect(registry.get('etherscan')).toBe(a);
  });

  it('returns null for an unknown source', () => {
    const registry = new TransactionIngesterRegistry();
    expect(registry.get('does-not-exist')).toBeNull();
  });

  it('throws a clear error from require() for an unknown source', () => {
    const registry = new TransactionIngesterRegistry();
    expect(() => registry.require('missing-source')).toThrow(
      /No TransactionIngester registered for source 'missing-source'/
    );
  });

  it('returns the ingester from require() when it is registered', () => {
    const registry = new TransactionIngesterRegistry();
    const stub = makeStub('binance-api');
    registry.register(stub);
    expect(registry.require('binance-api')).toBe(stub);
  });

  it('lists every registered source', () => {
    const registry = new TransactionIngesterRegistry();
    registry.register(makeStub('etherscan'));
    registry.register(makeStub('statement'));
    registry.register(makeStub('screenshot'));
    expect(registry.list().sort()).toEqual(['etherscan', 'screenshot', 'statement']);
  });

  it('overwrites a duplicate registration (last writer wins)', () => {
    const registry = new TransactionIngesterRegistry();
    const first = makeStub('etherscan');
    const second = makeStub('etherscan');
    registry.register(first);
    registry.register(second);
    expect(registry.get('etherscan')).toBe(second);
  });
});
