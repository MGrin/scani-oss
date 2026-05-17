import { describe, expect, test } from 'bun:test';
import type { HoldingSnapshot } from '@scani/providers/core/types';
import { projectSnapshotToTokenMapping } from '../../../src/services/holdings/HoldingSnapshotProjection';

function snapshot(overrides: Partial<HoldingSnapshot['tokenIdentity']>): HoldingSnapshot {
  return {
    externalId: 'AAPL',
    balance: '10',
    capturedAt: new Date(),
    tokenType: 'stock',
    tokenIdentity: {
      symbol: 'AAPL',
      name: 'Apple Inc.',
      ...overrides,
    },
  };
}

describe('projectSnapshotToTokenMapping — marketSegment threading', () => {
  test('carries the provider-supplied marketSegment into the token mapping', () => {
    const mapping = projectSnapshotToTokenMapping(snapshot({ marketSegment: 'US' }));
    expect(mapping.token.marketSegment).toBe('US');
  });

  test('null marketSegment when the provider supplies none', () => {
    const mapping = projectSnapshotToTokenMapping(snapshot({}));
    expect(mapping.token.marketSegment).toBeNull();
  });
});
