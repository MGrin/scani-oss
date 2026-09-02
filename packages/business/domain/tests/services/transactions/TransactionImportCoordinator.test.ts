import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NewHoldingTransaction } from '@scani/db/schema';
import { Container } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../../src/repositories/HoldingBalanceObservationRepository';
import {
  type CoverageUpsertMerge,
  type CoverageUpsertResult,
  HoldingCoverageRepository,
} from '../../../src/repositories/HoldingCoverageRepository';
import {
  type BulkUpsertMerge,
  HoldingTransactionRepository,
} from '../../../src/repositories/HoldingTransactionRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { OpeningBalanceReconciliationService } from '../../../src/services/holdings/OpeningBalanceReconciliationService';
import {
  resolveImportWalletAddress,
  resolveInstitutionCode,
  TransactionImportCoordinator,
  TransactionImportUnrecoverableError,
} from '../../../src/services/transactions/TransactionImportCoordinator';
import {
  TransactionRouter,
  type TransactionRouterResult,
} from '../../../src/services/transactions/TransactionRouter';
import {
  NON_EVM_WALLET_SOURCES,
  sourceForChainId,
} from '../../../src/services/transactions/transaction-source';
import { IntegrationCredentialsService } from '../../../src/services/users/IntegrationCredentialsService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

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
  readonly ingesterRows: Array<{
    holdingId: string;
    firstTxAt: Date | null;
    lastTxAt: Date | null;
  }> = [];
  throwOnRetract = false;

  async retractCompleteHistoryClaim(accountId: string, source: string): Promise<number> {
    this.retractions.push({ accountId, source });
    if (this.throwOnRetract) throw new Error('coverage table unreachable');
    return 1;
  }

  ingesterOpts: Array<{ completenessIsClaimed?: boolean }> = [];
  /** What the repository reports having collapsed — empty on a clean batch. */
  ingesterMerges: CoverageUpsertMerge[] = [];

  async upsertManyFromIngester(
    rows: ReadonlyArray<{ holdingId: string; firstTxAt: Date | null; lastTxAt: Date | null }>,
    opts: { completenessIsClaimed?: boolean } = {}
  ): Promise<CoverageUpsertResult> {
    this.ingesterRows.push(...rows);
    this.ingesterOpts.push(opts);
    return { written: rows.length, merges: this.ingesterMerges };
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

// Class-field DI resolves at construction, so the stubs have to be on the
// container before the coordinator is built — the one from `beforeEach`
// already holds the real ledger repository.
//
// `persistAndReport` is the function these tickets name. Reaching it
// through `execute` would mean standing up a provider, credentials and an
// account row to test a step that happens after all three.
function persistWithStubs(bulkUpserted: string[], merges: BulkUpsertMerge[] = []) {
  Container.set(HoldingTransactionRepository, {
    bulkUpsert: async (rows: Array<{ holdingId: string }>) => {
      bulkUpserted.push(...rows.map((r) => r.holdingId));
      return { rows, merges };
    },
  });
  Container.set(OpeningBalanceReconciliationService, {
    reconcileHolding: async () => undefined,
  });
  const c = new TransactionImportCoordinator();
  // biome-ignore lint/complexity/useLiteralKeys: dot access on a private member is a TS error; bracket notation is the only way to reach the method under test.
  return c['persistAndReport'].bind(c);
}

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

// SC-308. `result.firstEventAt` / `lastEventAt` are a single min/max over
// every event in a run, across every holding. They were written to each
// holding the run touched, so a Kraken account holding BTC since 2021 and
// a token bought last week put 2021 on both rows — and `LEAST` in the
// upsert made it permanent, since the value could only ever move earlier.
//
// The bounds are derived per holding from the ledger now (see
// `HoldingTransactionRepository — coverage follows the ledger`). What this
// asserts is the other half: that the run's own summary never reaches a
// holding's row again, whatever the run's shape.
describe("TransactionImportCoordinator — the run's oldest event is not a holding's", () => {
  const OLD_HOLDING = '00000000-0000-4000-8000-00000000000a';
  const NEW_HOLDING = '00000000-0000-4000-8000-00000000000b';
  const RUN_OLDEST = new Date('2021-05-05T00:00:00Z');
  const RUN_NEWEST = new Date('2026-08-09T00:00:00Z');

  function tx(holdingId: string, occurredAt: Date, externalId: string): NewHoldingTransaction {
    return {
      userId: '00000000-0000-4000-8000-000000000001',
      holdingId,
      tokenId: '00000000-0000-4000-8000-00000000000c',
      kind: 'buy',
      quantity: '1',
      occurredAt,
      externalId,
      source: 'kraken-api',
    };
  }

  function routerResult(): TransactionRouterResult {
    return {
      transactions: [tx(OLD_HOLDING, RUN_OLDEST, 'btc-1'), tx(NEW_HOLDING, RUN_NEWEST, 'new-1')],
      observations: [],
      warnings: [],
      firstEventAt: RUN_OLDEST,
      lastEventAt: RUN_NEWEST,
      hasCompleteTxHistory: true,
      historyRetractions: [],
      historyStartsAt: null,
    };
  }

  test('neither holding is stamped with the bounds of the run', async () => {
    const bulkUpserted: string[] = [];
    const persist = persistWithStubs(bulkUpserted);

    await persist('user-1', 'account-1', 'kraken-api', routerResult(), new Date('2026-01-01'));

    expect(coverage.ingesterRows).toHaveLength(2);
    for (const row of coverage.ingesterRows) {
      expect(row.firstTxAt).toBeNull();
      expect(row.lastTxAt).toBeNull();
    }
    // The ledger write is what carries the per-holding bounds now, so both
    // holdings have to have reached it.
    expect(new Set(bulkUpserted)).toEqual(new Set([OLD_HOLDING, NEW_HOLDING]));
  });

  // SC-360. Wiring wallets into the nightly sync pointed an incremental run
  // at 39 production holdings whose coverage said "complete". A `since` run
  // reports hasCompleteTxHistory=false because it asked for a window, and
  // writing that through would have retracted all 39 — silently, and into
  // the flag cost basis is computed from (SC-149).
  test('an incremental run does not present its completeness as a claim', async () => {
    const persist = persistWithStubs([]);

    await persist('user-1', 'account-1', 'etherscan', routerResult(), new Date('2026-01-01'));

    expect(coverage.ingesterOpts).toHaveLength(1);
    expect(coverage.ingesterOpts[0]?.completenessIsClaimed).toBe(false);
  });

  test('a full-history run does claim it', async () => {
    const persist = persistWithStubs([]);

    await persist('user-1', 'account-1', 'etherscan', routerResult(), undefined);

    expect(coverage.ingesterOpts[0]?.completenessIsClaimed).toBe(true);
  });

  // SC-395. Two different falses arrive on the same boolean. "I was only
  // asked for a window" is silence about the whole ledger and must not
  // retract; "the feed contradicts itself over the entries it returned" is
  // evidence about it, and a nightly run is exactly where that evidence
  // shows up, because a full re-import is something a person triggers by
  // hand and may never do again.
  test('an incremental run that the provider retracted writes the retraction through', async () => {
    const persist = persistWithStubs([]);
    const retracted: TransactionRouterResult = {
      ...routerResult(),
      hasCompleteTxHistory: false,
      historyRetractions: ['kraken: the ledger contradicts itself over the 492 entries returned'],
    };

    await persist('user-1', 'account-1', 'kraken-api', retracted, new Date('2026-01-01'));

    expect(coverage.ingesterOpts[0]?.completenessIsClaimed).toBe(true);
  });

  // The negative control for the clause above. Without it, the test just
  // above passes for a `completenessIsClaimed: true` that ignores `since`
  // entirely — which is SC-360 re-introduced, and the nightly sync silently
  // retracting 39 wallets is what that costs.
  test('an incremental run with nothing retracted still makes no claim', async () => {
    const persist = persistWithStubs([]);
    const notRetracted: TransactionRouterResult = {
      ...routerResult(),
      hasCompleteTxHistory: false,
      historyRetractions: [],
      historyStartsAt: null,
    };

    await persist('user-1', 'account-1', 'kraken-api', notRetracted, new Date('2026-01-01'));

    expect(coverage.ingesterOpts[0]?.completenessIsClaimed).toBe(false);
  });

  test('the run summary itself still reports the run', async () => {
    const persist = persistWithStubs([]);

    const summary = await persist(
      'user-1',
      'account-1',
      'kraken-api',
      routerResult(),
      new Date('2026-01-01')
    );

    expect(summary.firstEventAt).toBe(RUN_OLDEST.toISOString());
    expect(summary.lastEventAt).toBe(RUN_NEWEST.toISOString());
  });
});

// SC-331. `user_integration_credentials` is UNIQUE (user_id,
// institution_id), so a user with three Ethereum wallets has ONE Ethereum
// credential holding ONE address. Resolving a wallet import's address from
// there gave every Ethereum account the same address's history: in
// production one wallet's on-chain events were copied across every Ethereum
// account, more than doubling the row count, and most of the surplus was a
// copy of a transfer the account it sat on never made. The address has to
// come from the account.
describe('TransactionImportCoordinator — a wallet import reads its own account address', () => {
  const ACCOUNT = '00000000-0000-4000-8000-0000000000aa';

  test('the wallet address comes from the account, not the shared credential', () => {
    expect(
      resolveImportWalletAddress('etherscan', ACCOUNT, {
        chainId: '1',
        walletAddress: '0xb0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9',
      })
    ).toBe('0xb0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9');
  });

  test('two accounts sharing one institution credential resolve to different addresses', () => {
    const first = resolveImportWalletAddress('etherscan', ACCOUNT, {
      walletAddress: '0xa11ce0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7',
    });
    const second = resolveImportWalletAddress('etherscan', ACCOUNT, {
      walletAddress: '0xc0ffee11223344556677889900aabbccddeeff01',
    });
    expect(first).not.toBe(second);
  });

  // Falling back to the credential is the bug itself, and it fails silently:
  // the import succeeds and writes another wallet's real history. Refusing to
  // run is the only outcome that surfaces the misconfiguration.
  test('a wallet account with no address refuses to run rather than falling back', () => {
    expect(() => resolveImportWalletAddress('etherscan', ACCOUNT, { chainId: '1' })).toThrow(
      TransactionImportUnrecoverableError
    );
    expect(() => resolveImportWalletAddress('solana', ACCOUNT, {})).toThrow(
      /no metadata.walletAddress/
    );
    expect(() => resolveImportWalletAddress('etherscan', ACCOUNT, { walletAddress: '  ' })).toThrow(
      TransactionImportUnrecoverableError
    );
    expect(() => resolveImportWalletAddress('etherscan', ACCOUNT, null)).toThrow(
      TransactionImportUnrecoverableError
    );
  });

  // Exchange credentials are genuinely per-institution — one Kraken key
  // serves the Kraken account — so this must not touch them.
  test('exchange sources are untouched and keep using the credential row', () => {
    expect(resolveImportWalletAddress('kraken-api', ACCOUNT, {})).toBeUndefined();
    expect(resolveImportWalletAddress('ibkr-api', ACCOUNT, null)).toBeUndefined();
  });
});

// SC-364. A source tag `sourceForChainId` can return but this function
// cannot dispatch does not skip the account — it fails the account's
// nightly job with `unsupported-source`, which is strictly worse than
// not importing at all. The two used to be separate lists; now the
// non-EVM branch reads the map's own values, and this asserts the
// pairing so a chain added to one side cannot ship without the other.
describe('resolveInstitutionCode', () => {
  test('every source a chain id can resolve to is dispatchable', () => {
    for (const source of NON_EVM_WALLET_SOURCES) {
      expect(resolveInstitutionCode(source, {})).toBe(source);
    }
  });

  test('the newly wired chains reach their providers', () => {
    expect(resolveInstitutionCode(sourceForChainId(0) as string, { chainId: 0 })).toBe('bitcoin');
    expect(resolveInstitutionCode(sourceForChainId(-1) as string, { chainId: -1 })).toBe('tron');
    expect(resolveInstitutionCode(sourceForChainId(-15) as string, { chainId: -15 })).toBe('ton');
  });

  test('CEX tags map to their institution, EVM tags to their chain', () => {
    expect(resolveInstitutionCode('kraken-api', {})).toBe('kraken');
    expect(resolveInstitutionCode('etherscan', { chainId: '8453' })).toBe('base');
  });

  test('an unwired source is still unrecoverable rather than a guess', () => {
    expect(() => resolveInstitutionCode('cardano', {})).toThrow(
      TransactionImportUnrecoverableError
    );
    expect(() => resolveInstitutionCode('cardano', {})).toThrow(/No provider wired/);
  });

  test('an EVM tag on an unknown chain does not fall through to the tag', () => {
    expect(() => resolveInstitutionCode('etherscan', { chainId: 999999 })).toThrow(
      /not a known active EVM chain/
    );
    expect(() => resolveInstitutionCode('etherscan', {})).toThrow(/missing chainId/);
  });
});

// SC-349. `bulkUpsert` has to collapse rows sharing
// `(holdingId, source, externalId)` — Postgres refuses a statement that
// carries the conflict key twice — but the collapse used to leave no
// trace anywhere. That is how SC-341 lost 13 legs while all nine import
// jobs reported `status: 'ok'`, `warnings: []` and
// `hasCompleteTxHistory: true`. A merge inside one batch can be
// legitimate (a source genuinely re-sending one event), so this is an
// audit trail rather than a failure — but it has to reach the job summary
// a person actually reads.
describe('TransactionImportCoordinator — a merged batch says so in the summary', () => {
  const HOLDING = '00000000-0000-4000-8000-00000000000a';

  function routerResult(): TransactionRouterResult {
    return {
      transactions: [
        {
          userId: '00000000-0000-4000-8000-000000000001',
          holdingId: HOLDING,
          tokenId: '00000000-0000-4000-8000-00000000000c',
          kind: 'transfer_in',
          quantity: '1',
          occurredAt: new Date('2026-08-01T00:00:00Z'),
          externalId: '0xdeadbeef',
          source: 'etherscan',
        },
      ],
      observations: [],
      warnings: [],
      firstEventAt: new Date('2026-08-01T00:00:00Z'),
      lastEventAt: new Date('2026-08-01T00:00:00Z'),
      hasCompleteTxHistory: true,
      historyRetractions: [],
      historyStartsAt: null,
    };
  }

  test('the collapsed rows become a warning naming the source and the count', async () => {
    const persist = persistWithStubs(
      [],
      [
        { holdingId: HOLDING, source: 'etherscan', externalId: '0xdeadbeef', dropped: 2 },
        { holdingId: HOLDING, source: 'etherscan', externalId: '0xfeed', dropped: 1 },
      ]
    );

    const summary = await persist('user-1', 'account-1', 'etherscan', routerResult(), undefined);

    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toContain('etherscan');
    // Three rows stopped existing, across two dedup keys.
    expect(summary.warnings[0]).toContain('3');
    expect(summary.warnings[0]).toContain('2');
  });

  test('a batch with nothing merged adds no warning', async () => {
    const persist = persistWithStubs([]);

    const summary = await persist('user-1', 'account-1', 'etherscan', routerResult(), undefined);

    expect(summary.warnings).toEqual([]);
  });

  // SC-366, the same shape one table over. The coverage batch is built
  // from a `Set` here, so this cannot fire today — which is exactly why
  // the signal has to exist before a second producer arrives, since a
  // collapse that reaches nobody is indistinguishable from a clean run.
  test('a collapsed coverage batch reaches the same summary', async () => {
    coverage.ingesterMerges = [{ holdingId: HOLDING, dropped: 1 }];
    const persist = persistWithStubs([]);

    const summary = await persist('user-1', 'account-1', 'etherscan', routerResult(), undefined);

    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toContain('1 coverage row(s) across 1 dedup key(s)');
    expect(summary.warnings[0]).toContain(HOLDING);
  });

  test('a collapsed coverage batch does not retract the run completeness claim', async () => {
    coverage.ingesterMerges = [{ holdingId: HOLDING, dropped: 1 }];
    const persist = persistWithStubs([]);

    const summary = await persist('user-1', 'account-1', 'etherscan', routerResult(), undefined);

    expect(summary.hasCompleteTxHistory).toBe(true);
    expect(coverage.ingesterOpts).toEqual([{ completenessIsClaimed: true }]);
  });

  // The merge is reported, not acted on. `completenessIsClaimed` exists
  // because a run that read a window must not retract a full import's
  // claim (#948); flipping it here would retract that claim on what may
  // be one legitimate re-sent event, which is the same harm from the
  // other direction.
  test('the merge does not retract the run completeness claim', async () => {
    const persist = persistWithStubs(
      [],
      [{ holdingId: HOLDING, source: 'etherscan', externalId: '0xdeadbeef', dropped: 2 }]
    );

    const summary = await persist('user-1', 'account-1', 'etherscan', routerResult(), undefined);

    expect(coverage.ingesterOpts[0]?.completenessIsClaimed).toBe(true);
    expect(summary.hasCompleteTxHistory).toBe(true);
  });
});
