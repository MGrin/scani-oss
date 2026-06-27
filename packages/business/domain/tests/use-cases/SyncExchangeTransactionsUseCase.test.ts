import { afterAll, describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { AccountRepository } from '../../src/repositories/AccountRepository';
import { InstitutionRepository } from '../../src/repositories/InstitutionRepository';
import { UserIntegrationCredentialsRepository } from '../../src/repositories/UserIntegrationCredentialsRepository';
import { SyncExchangeTransactionsUseCase } from '../../src/use-cases/SyncExchangeTransactionsUseCase';

// Capture the real @Service repository instances before any test stubs
// them — typedi's Container is a process-wide singleton, so unrestored
// stubs would leak into other test files (InstitutionService /
// AccountService) that resolve these repos for real.
const realInstitutionRepo = Container.get(InstitutionRepository);
const realCredentialsRepo = Container.get(UserIntegrationCredentialsRepository);
const realAccountRepo = Container.get(AccountRepository);

afterAll(() => {
  Container.set(InstitutionRepository, realInstitutionRepo);
  Container.set(UserIntegrationCredentialsRepository, realCredentialsRepo);
  Container.set(AccountRepository, realAccountRepo);
});

type Inst = { id: string; name: string };
type Acc = { id: string; institutionId: string; isActive: boolean };

function makeUseCase(opts: {
  institutions: Inst[];
  credsByInstitution: Record<string, Array<{ userId: string }>>;
  accountsByUser: Record<string, Acc[]>;
}) {
  Container.set(InstitutionRepository, {
    findSyncableInstitutions: async () => opts.institutions,
  } as unknown as InstitutionRepository);
  Container.set(UserIntegrationCredentialsRepository, {
    findByInstitution: async (id: string) => opts.credsByInstitution[id] ?? [],
  } as unknown as UserIntegrationCredentialsRepository);
  Container.set(AccountRepository, {
    findByUser: async (userId: string) => opts.accountsByUser[userId] ?? [],
  } as unknown as AccountRepository);
  return new SyncExchangeTransactionsUseCase();
}

describe('SyncExchangeTransactionsUseCase', () => {
  test('returns a target per active account with provider source + ~30d since', async () => {
    const useCase = makeUseCase({
      institutions: [{ id: 'inst-ibkr', name: 'Interactive Brokers' }],
      credsByInstitution: { 'inst-ibkr': [{ userId: 'u1' }] },
      accountsByUser: { u1: [{ id: 'acc1', institutionId: 'inst-ibkr', isActive: true }] },
    });

    const res = await useCase.execute();

    expect(res.targets.length).toBe(1);
    expect(res.targets[0]).toMatchObject({
      userId: 'u1',
      accountId: 'acc1',
      source: 'ibkr-api',
      institutionId: 'inst-ibkr',
    });
    const ageDays =
      (Date.now() - new Date(res.targets[0]?.since ?? 0).getTime()) / (24 * 60 * 60 * 1000);
    expect(ageDays).toBeGreaterThan(29);
    expect(ageDays).toBeLessThan(31);
    expect(res.accountsFound).toBe(1);
  });

  test('skips accounts whose provider has no ingester source', async () => {
    const useCase = makeUseCase({
      institutions: [{ id: 'inst-x', name: 'Some Unsupported Bank' }],
      credsByInstitution: { 'inst-x': [{ userId: 'u1' }] },
      accountsByUser: { u1: [{ id: 'accX', institutionId: 'inst-x', isActive: true }] },
    });

    const res = await useCase.execute();

    expect(res.targets.length).toBe(0);
    expect(res.skippedNoSource).toBe(1);
    expect(res.accountsFound).toBe(1);
  });

  test('ignores inactive accounts and accounts of other institutions', async () => {
    const useCase = makeUseCase({
      institutions: [{ id: 'inst-kraken', name: 'Kraken' }],
      credsByInstitution: { 'inst-kraken': [{ userId: 'u1' }] },
      accountsByUser: {
        u1: [
          { id: 'acc-active', institutionId: 'inst-kraken', isActive: true },
          { id: 'acc-inactive', institutionId: 'inst-kraken', isActive: false },
          { id: 'acc-other', institutionId: 'inst-other', isActive: true },
        ],
      },
    });

    const res = await useCase.execute();

    expect(res.targets.map((t) => t.accountId)).toEqual(['acc-active']);
  });
});
