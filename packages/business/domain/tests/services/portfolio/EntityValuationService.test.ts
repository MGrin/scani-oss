process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { EntityRepository } from '../../../src/repositories/EntityRepository';
import {
  EntityValuationService,
  UNASSIGNED_ENTITY,
} from '../../../src/services/portfolio/EntityValuationService';
import type { PortfolioValueResult } from '../../../src/services/portfolio/PortfolioValuationService';
import { PortfolioValuationService } from '../../../src/services/portfolio/PortfolioValuationService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

const PERSONAL = 'entity-personal';
const COMPANY = 'entity-company';

function makeService(): EntityValuationService {
  Container.set(PortfolioValuationService, {} as PortfolioValuationService);
  Container.set(EntityRepository, {} as EntityRepository);
  const instance = new EntityValuationService();
  Container.set(EntityValuationService, instance);
  return instance;
}

function pHolding(
  accountId: string,
  tokenSymbol: string,
  balance: string,
  value: string | null,
  isActive = true
): PortfolioValueResult['holdings'][number] {
  return {
    accountId,
    tokenSymbol,
    balance,
    currentPrice: value === null ? null : new Decimal(value).div(balance).toString(),
    value,
    isActive,
  };
}

/**
 * A portfolio whose `totalValue` is computed EXACTLY as
 * `PortfolioValuationService` computes it — the sum of `value` over the
 * holdings that pass the inclusion contract. Building the fixture this way
 * rather than writing a total by hand is what makes the invariant test below
 * mean something: a hand-written total could agree with the buckets while both
 * disagreed with the real service.
 */
function portfolio(holdings: PortfolioValueResult['holdings']): PortfolioValueResult {
  const totalValue = holdings.reduce(
    (sum, h) => (h.isActive && h.value !== null ? sum.add(new Decimal(h.value)) : sum),
    new Decimal(0)
  );
  return { totalValue: totalValue.toString(), baseCurrency: 'USD', holdings };
}

describe('EntityValuationService.valueByEntity', () => {
  /**
   * The whole ticket, as one assertion (SC-463).
   *
   * A holding in each set of books, and the two totals have to add up to the
   * combined one EXACTLY. Get it wrong one way and the per-entity totals
   * double-count; the other way and the combined view under-reports. Both are
   * silent — nothing errors, two screens just disagree — which is why this is
   * an equality on the figures rather than a check that the code ran.
   */
  test('entity A + entity B + unassigned === the combined total, exactly', () => {
    const service = makeService();
    const value = portfolio([
      pHolding('acc-personal', 'AAPL', '3', '600'),
      pHolding('acc-company', 'USD', '4200.55', '4200.55'),
      pHolding('acc-loose', 'EUR', '100', '108.20'),
    ]);
    const accountEntity = new Map<string, string | null>([
      ['acc-personal', PERSONAL],
      ['acc-company', COMPANY],
      ['acc-loose', null],
    ]);

    const { entities, unassigned } = service.valueByEntity(
      [PERSONAL, COMPANY],
      value,
      accountEntity
    );

    expect(entities.map((e) => [e.entityId, e.value])).toEqual([
      [PERSONAL, '600'],
      [COMPANY, '4200.55'],
    ]);
    expect(unassigned.value).toBe('108.2');

    // The identity, stated on the figures a person reads rather than on the
    // fact that three buckets were produced.
    const summed = [...entities, unassigned].reduce(
      (sum, bucket) => sum.add(new Decimal(bucket.value)),
      new Decimal(0)
    );
    expect(summed.toString()).toBe(value.totalValue);
    expect(summed.toString()).toBe('4908.75');
  });

  /**
   * The opposite failure, and the reason `unassigned` is always returned. If a
   * holding whose account is in no entity were dropped instead of bucketed, the
   * parts would be short of the whole and the combined view would be the only
   * place the money still appeared.
   */
  test('an account in no entity is bucketed, never dropped', () => {
    const service = makeService();
    const value = portfolio([pHolding('acc-loose', 'BTC', '0.5', '30000')]);

    const { entities, unassigned } = service.valueByEntity(
      [PERSONAL],
      value,
      new Map<string, string | null>([['acc-loose', null]])
    );

    expect(entities[0]).toMatchObject({ entityId: PERSONAL, value: '0', holdingsCounted: 0 });
    expect(unassigned).toMatchObject({ value: '30000', holdingsCounted: 1 });
    expect(new Decimal(unassigned.value).toString()).toBe(value.totalValue);
  });

  /**
   * An account pointing at an entity that no longer exists — deleted between
   * the two reads, or by another session. It must land in `unassigned` rather
   * than in a bucket nobody asked for or in no bucket at all.
   */
  test('an account naming an unknown entity falls back to unassigned', () => {
    const service = makeService();
    const value = portfolio([pHolding('acc-x', 'USD', '10', '10')]);

    const { entities, unassigned } = service.valueByEntity(
      [PERSONAL],
      value,
      new Map<string, string | null>([['acc-x', 'entity-deleted']])
    );

    expect(entities[0]?.value).toBe('0');
    expect(unassigned.value).toBe('10');
  });

  /** Inactive holdings are out of `totalValue`, so they must be out of the
   *  buckets too or the parts would exceed the whole. */
  test('an inactive holding counts in no bucket, matching the combined total', () => {
    const service = makeService();
    const value = portfolio([
      pHolding('acc-personal', 'AAPL', '1', '200'),
      pHolding('acc-personal', 'DEAD', '5', '999', false),
    ]);

    const { entities } = service.valueByEntity(
      [PERSONAL],
      value,
      new Map<string, string | null>([['acc-personal', PERSONAL]])
    );

    expect(entities[0]).toMatchObject({ value: '200', holdingsCounted: 1 });
    expect(entities[0]?.value).toBe(value.totalValue);
  });

  /**
   * An unpriceable position is unknown, not zero. It is named beside its
   * boundary's total so the figure declares its own coverage, exactly as
   * `GroupValuationService` does — and it must not be folded into the total,
   * because `totalValue` does not fold it in either.
   */
  test('an unpriceable position is named beside its entity, never folded in', () => {
    const service = makeService();
    const value = portfolio([
      pHolding('acc-company', 'USD', '100', '100'),
      pHolding('acc-company', 'MYSTERY', '7', null),
      pHolding('acc-company', 'ZERO', '0', null),
    ]);

    const { entities } = service.valueByEntity(
      [COMPANY],
      value,
      new Map<string, string | null>([['acc-company', COMPANY]])
    );

    expect(entities[0]).toMatchObject({
      value: '100',
      unpricedSymbols: ['MYSTERY'],
      // The zero-balance row needs no price and is counted as covered.
      holdingsCounted: 2,
    });
    expect(entities[0]?.value).toBe(value.totalValue);
  });

  /** An empty set of books is a fact about the portfolio. Omitting it would
   *  make "the company holds nothing yet" render as "there is no company". */
  test('an entity holding nothing still returns a zero row', () => {
    const service = makeService();
    const { entities, unassigned } = service.valueByEntity(
      [PERSONAL, COMPANY],
      portfolio([]),
      new Map()
    );

    expect(entities.map((e) => e.entityId)).toEqual([PERSONAL, COMPANY]);
    expect(entities.every((e) => e.value === '0')).toBe(true);
    expect(unassigned).toMatchObject({ entityId: UNASSIGNED_ENTITY, value: '0' });
  });
});
