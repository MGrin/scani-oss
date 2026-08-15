import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../../src/repositories/HoldingBalanceObservationRepository';
import { HoldingCoverageRepository } from '../../../src/repositories/HoldingCoverageRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { OpeningBalanceReconciliationService } from '../../../src/services/holdings/OpeningBalanceReconciliationService';
import { TransactionImportCoordinator } from '../../../src/services/transactions/TransactionImportCoordinator';
import { TransactionRouter } from '../../../src/services/transactions/TransactionRouter';
import { IntegrationCredentialsService } from '../../../src/services/users/IntegrationCredentialsService';

// SC-168. `persistAndReport` is the only writer of
// `has_complete_tx_history` and it sits on the success path, so before
// this a failed run left the last success's claim standing — and since
// SC-149 that claim drives cost basis. What the coordinator owes is a
// retraction on the way out, at the (account, source) scope a failed run
// actually has.

interface Retraction {
  accountId: string;
  source: string;
}

class StubCoverageRepository {
  readonly retractions: Retraction[] = [];
  throwOnRetract = false;

  async retractCompleteHistoryClaim(accountId: string, source: string): Promise<number> {
    this.retractions.push({ accountId, source });
    if (this.throwOnRetract) throw new Error('coverage table unreachable');
    return 1;
  }
}

let coverage: StubCoverageRepository;
let coordinator: TransactionImportCoordinator;

beforeEach(() => {
  coverage = new StubCoverageRepository();
  Container.set(HoldingCoverageRepository, coverage);
  coordinator = new TransactionImportCoordinator();
  Container.set(TransactionImportCoordinator, coordinator);
});

afterEach(() => {
  // Hand the container working instances back — other suites in this
  // process resolve these for real.
  Container.set(HoldingCoverageRepository, new HoldingCoverageRepository());
  Container.set(HoldingTransactionRepository, new HoldingTransactionRepository());
  Container.set(HoldingBalanceObservationRepository, new HoldingBalanceObservationRepository());
  Container.set(TokenRepository, new TokenRepository());
  Container.set(OpeningBalanceReconciliationService, new OpeningBalanceReconciliationService());
  Container.set(IntegrationCredentialsService, new IntegrationCredentialsService());
  Container.set(TransactionRouter, new TransactionRouter());
});

// A nonexistent account is the earliest failure `execute` has — earlier
// than any provider call. It is deliberately the one under test: the
// retraction has to hang off every exit, not just the provider throw,
// because "the run failed before it could name a holding" is exactly the
// case the task says option 1 has to answer.
const INPUT = {
  userId: '00000000-0000-4000-8000-000000000001',
  accountId: '00000000-0000-4000-8000-000000000002',
  source: 'bybit-api',
};

describe('TransactionImportCoordinator — a failed run retracts its completeness claim', () => {
  test('the retraction is scoped to the (account, source) the run was for', async () => {
    await expect(coordinator.execute(INPUT)).rejects.toThrow();
    expect(coverage.retractions).toEqual([{ accountId: INPUT.accountId, source: INPUT.source }]);
  });

  test('the caller still gets the real failure, not the retraction', async () => {
    await expect(coordinator.execute(INPUT)).rejects.toThrow(/not found/);
  });

  test('a retraction that itself fails does not mask the failure that caused it', async () => {
    coverage.throwOnRetract = true;
    await expect(coordinator.execute(INPUT)).rejects.toThrow(/not found/);
    expect(coverage.retractions).toHaveLength(1);
  });
});
