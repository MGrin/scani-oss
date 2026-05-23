import { describe, expect, it } from 'bun:test';
import type { HoldingSnapshot } from '@scani/providers/core/types';
import { resolveSnapshotTokenType } from '../../../src/use-cases/lib/resolveSnapshotTokenType';

const TYPE_MAP = {
  fiat: 'fiat-uuid',
  crypto: 'crypto-uuid',
  stock: 'stock-uuid',
};

function makeSnapshot(tokenType?: string): HoldingSnapshot {
  return {
    externalId: 'X',
    tokenIdentity: { symbol: 'X' },
    balance: '1',
    capturedAt: new Date(),
    ...(tokenType ? { tokenType } : {}),
  };
}

describe('resolveSnapshotTokenType', () => {
  it("maps Kraken's USD-as-fiat snapshot to the existing fiat token type", () => {
    expect(resolveSnapshotTokenType(makeSnapshot('fiat'), TYPE_MAP, 'crypto-uuid')).toBe(
      'fiat-uuid'
    );
  });

  it("maps IBKR's cash-leg snapshot to fiat (not stock)", () => {
    expect(resolveSnapshotTokenType(makeSnapshot('fiat'), TYPE_MAP, 'stock-uuid')).toBe(
      'fiat-uuid'
    );
  });

  it("maps IBKR's equity snapshot to stock when declared", () => {
    expect(resolveSnapshotTokenType(makeSnapshot('stock'), TYPE_MAP, 'crypto-uuid')).toBe(
      'stock-uuid'
    );
  });

  it('falls back to the provided fallback when the snapshot omits tokenType', () => {
    expect(resolveSnapshotTokenType(makeSnapshot(undefined), TYPE_MAP, 'crypto-uuid')).toBe(
      'crypto-uuid'
    );
  });

  it('falls back when the declared tokenType has no row in the map', () => {
    expect(resolveSnapshotTokenType(makeSnapshot('rwa'), TYPE_MAP, 'crypto-uuid')).toBe(
      'crypto-uuid'
    );
  });
});
