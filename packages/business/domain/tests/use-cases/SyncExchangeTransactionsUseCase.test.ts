import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { AccountRepository } from '../../src/repositories/AccountRepository';
import { HoldingTransactionRepository } from '../../src/repositories/HoldingTransactionRepository';
import { InstitutionRepository } from '../../src/repositories/InstitutionRepository';
import { UserIntegrationCredentialsRepository } from '../../src/repositories/UserIntegrationCredentialsRepository';
import { SyncExchangeTransactionsUseCase } from '../../src/use-cases/SyncExchangeTransactionsUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

type Inst = { id: string; name: string };
type Acc = { id: string; institutionId: string; isActive: boolean; metadata?: unknown };

function makeUseCase(opts: {
  institutions: Inst[];
  credsByInstitution: Record<string, Array<{ userId: string }>>;
  accountsByUser: Record<string, Acc[]>;
  /** Account ids whose ledger already holds rows, keyed by source. */
  warmBySource?: Record<string, string[]>;
}) {
  Container.set(InstitutionRepository, {
    findTransactionSyncableInstitutions: async () => opts.institutions,
  } as unknown as InstitutionRepository);
  Container.set(UserIntegrationCredentialsRepository, {
    findByInstitution: async (id: string) => opts.credsByInstitution[id] ?? [],
  } as unknown as UserIntegrationCredentialsRepository);
  Container.set(AccountRepository, {
    findByUser: async (userId: string) => opts.accountsByUser[userId] ?? [],
  } as unknown as AccountRepository);
  Container.set(HoldingTransactionRepository, {
    findAccountsWithLedgerFor: async (accountIds: readonly string[], source: string) =>
      new Set((opts.warmBySource?.[source] ?? []).filter((id) => accountIds.includes(id))),
  } as unknown as HoldingTransactionRepository);
  return new SyncExchangeTransactionsUseCase();
}

const ageDays = (iso: string | undefined) =>
  (Date.now() - new Date(iso ?? 0).getTime()) / (24 * 60 * 60 * 1000);

describe('SyncExchangeTransactionsUseCase', () => {
  test('returns a target per active account with provider source + ~30d since', async () => {
    const useCase = makeUseCase({
      institutions: [{ id: 'inst-ibkr', name: 'Interactive Brokers' }],
      credsByInstitution: { 'inst-ibkr': [{ userId: 'u1' }] },
      accountsByUser: { u1: [{ id: 'acc1', institutionId: 'inst-ibkr', isActive: true }] },
      warmBySource: { 'ibkr-api': ['acc1'] },
    });

    const res = await useCase.execute();

    expect(res.targets.length).toBe(1);
    expect(res.targets[0]).toMatchObject({
      userId: 'u1',
      accountId: 'acc1',
      source: 'ibkr-api',
      institutionId: 'inst-ibkr',
    });
    expect(ageDays(res.targets[0]?.since)).toBeGreaterThan(29);
    expect(ageDays(res.targets[0]?.since)).toBeLessThan(31);
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
      warmBySource: { 'kraken-api': ['acc-active'] },
    });

    const res = await useCase.execute();

    expect(res.targets.map((t) => t.accountId)).toEqual(['acc-active']);
  });
});

// SC-360. Both halves of the gap: the institution set, and the source
// resolution once past it. Either alone kept wallets out entirely.
describe('SyncExchangeTransactionsUseCase — blockchain wallets', () => {
  test('emits a target for a Solana wallet, sourced from the account chainId', async () => {
    const useCase = makeUseCase({
      institutions: [{ id: 'inst-sol', name: 'Solana' }],
      credsByInstitution: { 'inst-sol': [{ userId: 'u1' }] },
      accountsByUser: {
        u1: [
          { id: 'acc-sol', institutionId: 'inst-sol', isActive: true, metadata: { chainId: -2 } },
        ],
      },
      warmBySource: { solana: ['acc-sol'] },
    });

    const res = await useCase.execute();

    expect(res.targets).toHaveLength(1);
    expect(res.targets[0]?.source).toBe('solana');
    expect(res.skippedNoSource).toBe(0);
  });

  test('every EVM chain resolves to the etherscan source', async () => {
    const useCase = makeUseCase({
      institutions: [
        { id: 'inst-eth', name: 'Ethereum' },
        { id: 'inst-base', name: 'Base' },
        { id: 'inst-op', name: 'Optimism' },
        { id: 'inst-poly', name: 'Polygon' },
      ],
      credsByInstitution: {
        'inst-eth': [{ userId: 'u1' }],
        'inst-base': [{ userId: 'u1' }],
        'inst-op': [{ userId: 'u1' }],
        'inst-poly': [{ userId: 'u1' }],
      },
      accountsByUser: {
        u1: [
          { id: 'a-eth', institutionId: 'inst-eth', isActive: true, metadata: { chainId: 1 } },
          {
            id: 'a-base',
            institutionId: 'inst-base',
            isActive: true,
            metadata: { chainId: '8453' },
          },
          { id: 'a-op', institutionId: 'inst-op', isActive: true, metadata: { chainId: 10 } },
          { id: 'a-poly', institutionId: 'inst-poly', isActive: true, metadata: { chainId: 137 } },
        ],
      },
    });

    const res = await useCase.execute();

    expect(res.targets.map((t) => t.source)).toEqual([
      'etherscan',
      'etherscan',
      'etherscan',
      'etherscan',
    ]);
  });

  // SC-364. Bitcoin's chain id is 0, which every falsy check on the way
  // here has to survive — the account used to be counted in
  // `skippedNoSource` because no source tag reached its provider at all.
  test('a Bitcoin wallet is dispatched on chain id 0, not skipped as falsy', async () => {
    const useCase = makeUseCase({
      institutions: [{ id: 'inst-btc', name: 'Bitcoin Network' }],
      credsByInstitution: { 'inst-btc': [{ userId: 'u1' }] },
      accountsByUser: {
        u1: [{ id: 'a-btc', institutionId: 'inst-btc', isActive: true, metadata: { chainId: 0 } }],
      },
    });

    const res = await useCase.execute();

    expect(res.targets).toHaveLength(1);
    expect(res.targets[0]?.source).toBe('bitcoin');
    expect(res.skippedNoSource).toBe(0);
  });

  test('Tron and TON dispatch from their sentinels too', async () => {
    const useCase = makeUseCase({
      institutions: [
        { id: 'inst-tron', name: 'Tron' },
        { id: 'inst-ton', name: 'TON' },
      ],
      credsByInstitution: { 'inst-tron': [{ userId: 'u1' }], 'inst-ton': [{ userId: 'u1' }] },
      accountsByUser: {
        u1: [
          { id: 'a-tron', institutionId: 'inst-tron', isActive: true, metadata: { chainId: -1 } },
          { id: 'a-ton', institutionId: 'inst-ton', isActive: true, metadata: { chainId: -15 } },
        ],
      },
    });

    const res = await useCase.execute();

    expect(res.targets.map((t) => t.source).sort()).toEqual(['ton', 'tron']);
    expect(res.skippedNoSource).toBe(0);
  });

  test('a wallet account with no chainId is skipped, not dispatched blind', async () => {
    const useCase = makeUseCase({
      institutions: [{ id: 'inst-eth', name: 'Ethereum' }],
      credsByInstitution: { 'inst-eth': [{ userId: 'u1' }] },
      accountsByUser: {
        u1: [{ id: 'a-eth', institutionId: 'inst-eth', isActive: true, metadata: {} }],
      },
    });

    const res = await useCase.execute();

    expect(res.targets).toHaveLength(0);
    expect(res.skippedNoSource).toBe(1);
  });
});

// The refill mechanism. Production's Solana ledger is empty and its whole
// history predates any nightly window, so a `since` on it restores nothing
// — every night, forever.
describe('SyncExchangeTransactionsUseCase — cold ledgers get full history', () => {
  test('omits `since` for an account with no rows from this source', async () => {
    const useCase = makeUseCase({
      institutions: [{ id: 'inst-sol', name: 'Solana' }],
      credsByInstitution: { 'inst-sol': [{ userId: 'u1' }] },
      accountsByUser: {
        u1: [
          { id: 'acc-sol', institutionId: 'inst-sol', isActive: true, metadata: { chainId: -2 } },
        ],
      },
      warmBySource: {},
    });

    const res = await useCase.execute();

    expect(res.targets[0]?.since).toBeUndefined();
    expect(res.fullHistoryTargets).toBe(1);
  });

  test('a warm account keeps the incremental window; a cold sibling does not', async () => {
    const useCase = makeUseCase({
      institutions: [{ id: 'inst-eth', name: 'Ethereum' }],
      credsByInstitution: { 'inst-eth': [{ userId: 'u1' }] },
      accountsByUser: {
        u1: [
          { id: 'a-warm', institutionId: 'inst-eth', isActive: true, metadata: { chainId: 1 } },
          { id: 'a-cold', institutionId: 'inst-eth', isActive: true, metadata: { chainId: 1 } },
        ],
      },
      warmBySource: { etherscan: ['a-warm'] },
    });

    const res = await useCase.execute();

    const warm = res.targets.find((t) => t.accountId === 'a-warm');
    const cold = res.targets.find((t) => t.accountId === 'a-cold');
    expect(ageDays(warm?.since)).toBeGreaterThan(29);
    expect(cold?.since).toBeUndefined();
    expect(res.fullHistoryTargets).toBe(1);
  });

  test('ledger lookup is batched per source, not per account', async () => {
    const calls: Array<{ source: string; ids: string[] }> = [];
    Container.set(InstitutionRepository, {
      findTransactionSyncableInstitutions: async () => [{ id: 'inst-eth', name: 'Ethereum' }],
    } as unknown as InstitutionRepository);
    Container.set(UserIntegrationCredentialsRepository, {
      findByInstitution: async () => [{ userId: 'u1' }],
    } as unknown as UserIntegrationCredentialsRepository);
    Container.set(AccountRepository, {
      findByUser: async () => [
        { id: 'a1', institutionId: 'inst-eth', isActive: true, metadata: { chainId: 1 } },
        { id: 'a2', institutionId: 'inst-eth', isActive: true, metadata: { chainId: 1 } },
        { id: 'a3', institutionId: 'inst-eth', isActive: true, metadata: { chainId: 1 } },
      ],
    } as unknown as AccountRepository);
    Container.set(HoldingTransactionRepository, {
      findAccountsWithLedgerFor: async (ids: readonly string[], source: string) => {
        calls.push({ source, ids: [...ids] });
        return new Set<string>();
      },
    } as unknown as HoldingTransactionRepository);

    await new SyncExchangeTransactionsUseCase().execute();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.ids).toEqual(['a1', 'a2', 'a3']);
  });
});
