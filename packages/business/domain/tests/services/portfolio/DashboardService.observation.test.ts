import { afterEach, expect, spyOn, test } from 'bun:test';
import { Container } from 'typedi';
import { AccountRepository } from '../../../src/repositories/AccountRepository';
import { GroupRepository } from '../../../src/repositories/GroupRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { VaultRepository } from '../../../src/repositories/VaultRepository';
import { AssetAllocationService } from '../../../src/services/portfolio/AssetAllocationService';
import { DashboardService } from '../../../src/services/portfolio/DashboardService';
import { PortfolioValuationService } from '../../../src/services/portfolio/PortfolioValuationService';

const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const portfolio = spyOn(
    Container.get(PortfolioValuationService),
    'getUserPortfolioValue'
  ).mockResolvedValue({ totalValue: '0', baseCurrency: 'USD', holdings: [] });
  const details = spyOn(
    Container.get(HoldingRepository),
    'findByUserWithFullDetails'
  ).mockResolvedValue([]);
  const groups = spyOn(Container.get(GroupRepository), 'hasActiveForUser').mockResolvedValue(false);
  const vaults = spyOn(Container.get(VaultRepository), 'hasActiveForUser').mockResolvedValue(false);
  const wrapped = spyOn(
    Container.get(AccountRepository),
    'hasWrappedAssetAccount'
  ).mockResolvedValue(false);
  const income = spyOn(
    Container.get(HoldingTransactionRepository),
    'hasIncomeForUser'
  ).mockResolvedValue(false);
  const allocation = spyOn(
    Container.get(AssetAllocationService),
    'calculateFromFetchedData'
  ).mockResolvedValue({
    items: [],
    totalDebt: '0',
    liabilityDebt: '0',
    totalValue: '0',
    baseCurrency: 'USD',
  });
  spies.push(portfolio, details, groups, vaults, wrapped, income, allocation);
  return {
    service: new DashboardService(),
    portfolio,
    details,
    groups,
    vaults,
    wrapped,
    income,
    allocation,
  };
}

test('measures all inclusive phases, keeps both parallel groups, and returns the same data', async () => {
  const f = setup();
  const heldPortfolio =
    deferred<Awaited<ReturnType<PortfolioValuationService['getUserPortfolioValue']>>>();
  f.portfolio.mockReturnValueOnce(heldPortfolio.promise);
  const heldAllocation =
    deferred<Awaited<ReturnType<AssetAllocationService['calculateFromFetchedData']>>>();
  f.allocation.mockReturnValueOnce(heldAllocation.promise);
  const observations: Array<{ phase?: string; durationMs?: number; cache?: string }> = [];
  const pending = f.service.getDashboardOverview('user', 'base', undefined, (o) =>
    observations.push(o)
  );
  expect(f.details).toHaveBeenCalledTimes(1);
  expect(f.groups).toHaveBeenCalledTimes(1);
  expect(f.income).toHaveBeenCalledTimes(1);
  await Bun.sleep(10);
  heldPortfolio.resolve({ totalValue: '0', baseCurrency: 'USD', holdings: [] });
  await Bun.sleep(10);
  expect(f.allocation).toHaveBeenCalledTimes(1);
  expect(observations.some((o) => o.phase === 'compose')).toBe(false);
  heldAllocation.resolve({
    items: [],
    totalDebt: '0',
    liabilityDebt: '0',
    totalValue: '0',
    baseCurrency: 'USD',
  });
  const result = await pending;
  expect(observations.map((o) => o.phase).sort()).toEqual([
    'compose',
    'details',
    'portfolio',
    'presence',
  ]);
  expect(observations.find((o) => o.phase === 'portfolio')!.durationMs).toBeGreaterThanOrEqual(9);
  expect(observations.find((o) => o.phase === 'compose')!.durationMs).toBeGreaterThanOrEqual(9);
  expect(result).toEqual(await f.service.getDashboardOverview('user', 'base'));
  expect(
    await f.service.getDashboardOverview('user', 'base', undefined, () => {
      throw new Error('observer');
    })
  ).toEqual(result);
});

test('a first rejection preserves the error without waiting for running siblings', async () => {
  const f = setup();
  const held = deferred<never[]>();
  f.details.mockReturnValueOnce(held.promise);
  const failure = new Error('original portfolio error');
  f.portfolio.mockRejectedValueOnce(failure);
  const observations: Array<{ phase?: string; cache?: string }> = [];
  await expect(
    f.service.getDashboardOverview('user', 'base', undefined, (o) => {
      observations.push(o);
      throw new Error('observer');
    })
  ).rejects.toBe(failure);
  expect(observations.some((o) => o.phase === 'portfolio')).toBe(true);
  expect(observations.some((o) => o.phase === 'details')).toBe(false);
  expect(f.allocation).not.toHaveBeenCalled();
  held.resolve([]);
});
