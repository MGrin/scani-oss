/**
 * The transaction import end to end against Postgres, through `execute`. Only
 * the provider (a stub registered for the run) and the credential lookup are
 * stubbed, so every row, holding, coverage row, notice and figure asserted here
 * is what the import wrote.
 *
 * Written against the router's path before it moved onto `FeedIngestService`
 * (foundation A2 Task 11) and kept as its characterization. Every assertion
 * that changed with the move says which ruling named the change; the history
 * figures did not change.
 *
 * Fixtures are committed rather than rolled back: the import opens its own
 * connections, and history reads committed rows.
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import type { TransactionsProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { NoticeInput, TransactionEvent } from '@scani/providers/core/types';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { FeedBatchRejected } from '../../../src/services/feeds/FeedIngestService';
import { FoundationClassificationService } from '../../../src/services/foundation/FoundationClassificationService';
import { TokenIdentityService } from '../../../src/services/tokens/TokenIdentityService';
import { TransactionImportCoordinator } from '../../../src/services/transactions/TransactionImportCoordinator';
import { IntegrationCredentialsService } from '../../../src/services/users/IntegrationCredentialsService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { makeInstitution, makeInstitutionType, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../../test/helpers/factories-extra';
import { captureHistory } from '../../../test/helpers/history-neutrality';
import { expectLabelsSettled } from '../../../test/helpers/labels-settled';

restoreContainerAfterAll();

Container.set(IntegrationCredentialsService, {
  getDecryptedCredentials: async () => ({ apiKey: 'stub-key', apiSecret: 'stub-secret' }),
} as unknown as IntegrationCredentialsService);

const DAY_MS = 86_400_000;
const MANUAL_AT = new Date('2026-05-20T00:00:00Z');
const at = (day: number) => new Date(Date.UTC(2026, 5, day, 10));

/** Unique per run, so committed tokens never meet another test's. */
const symbol = (prefix: string) =>
  `${prefix}${randomUUID().replace(/-/g, '').slice(0, 7).toUpperCase()}`;

const holdings = schema.holdings;
const ledger = schema.holdingTransactions;

const holdingsOf = (accountId: string) =>
  getDb()
    .select()
    .from(holdings)
    .where(eq(holdings.accountId, accountId))
    .orderBy(asc(holdings.createdAt), asc(holdings.id));

const ledgerOf = (userId: string) =>
  getDb()
    .select()
    .from(ledger)
    .where(eq(ledger.userId, userId))
    .orderBy(asc(ledger.occurredAt), asc(ledger.externalId), asc(ledger.kind));

const coverageOf = (holdingIds: readonly string[]) =>
  getDb()
    .select()
    .from(schema.holdingCoverage)
    .where(inArray(schema.holdingCoverage.holdingId, [...holdingIds]));

const inputsOf = (accountId: string) =>
  getDb().select().from(schema.feedInputs).where(eq(schema.feedInputs.accountId, accountId));

const windowsOf = (inputId: string) =>
  getDb()
    .select()
    .from(schema.feedInputWindows)
    .where(eq(schema.feedInputWindows.inputId, inputId));

const tokensWithSymbol = (symbols: readonly string[]) =>
  getDb()
    .select()
    .from(schema.tokens)
    .where(inArray(schema.tokens.symbol, [...symbols]));

interface ProviderScript {
  institutionCode: string;
  events: TransactionEvent[];
  horizonMs?: number;
  noteWith?: readonly NoticeInput[];
}

/** Registers a provider that answers `institutionCode` with these events, and nothing else. */
function serve(script: ProviderScript): void {
  const provider: TransactionsProvider = {
    providerKey: 'stub',
    capabilities: ['transactions'],
    canFetchTransactions: (code: string) => code === script.institutionCode,
    fetchTransactions: async (ctx) => {
      for (const reason of script.noteWith ?? []) ctx.noteWarning?.(reason);
      return script.events;
    },
    transactionHistoryHorizonMs: script.horizonMs,
  };
  const registry = new ProviderRegistry();
  registry.register(provider);
  Container.set(ProviderRegistry, registry);
}

const created = { users: [] as string[], symbols: [] as string[], institutions: [] as string[] };

afterEach(async () => {
  const db = getDb();
  const users = created.users.splice(0);
  const symbols = created.symbols.splice(0);
  const institutions = created.institutions.splice(0);
  // Users first: their holdings are what keep the tokens restricted.
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
  if (symbols.length) await db.delete(schema.tokens).where(inArray(schema.tokens.symbol, symbols));
  if (institutions.length) {
    await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutions));
  }
});

/** A user with one account at a fresh institution. */
async function seed(metadata: Record<string, unknown> = {}) {
  const fixture = await getDb().transaction(async (tx) => {
    const broker = await makeInstitutionType(tx, { code: 'broker' });
    const user = await makeUser(tx);
    const institution = await makeInstitution(tx, { typeId: broker.id });
    const account = await makeAccount(tx, {
      userId: user.id,
      institutionId: institution.id,
      metadata,
    });
    return { userId: user.id, accountId: account.id, institutionId: institution.id };
  });
  created.users.push(fixture.userId);
  created.institutions.push(fixture.institutionId);
  return fixture;
}

/** A catalog token, and optionally the account's holding of it with a value a person typed. */
async function catalogToken(name: string) {
  const sym = symbol(name.slice(0, 1).toUpperCase());
  created.symbols.push(sym);
  return await getDb().transaction((tx) => makeToken(tx, { symbol: sym, name }));
}

async function manualHolding(
  owner: { userId: string; accountId: string },
  tokenId: string,
  balance: string
) {
  const holding = await getDb().transaction(async (tx) => {
    const made = await makeHolding(tx, {
      userId: owner.userId,
      accountId: owner.accountId,
      tokenId,
      balance,
      source: 'manual',
      createdAt: MANUAL_AT,
      lastUpdated: MANUAL_AT,
    });
    await tx.insert(schema.holdingBalanceObservations).values({
      userId: owner.userId,
      holdingId: made.id,
      balance,
      observedAt: MANUAL_AT,
      source: 'sync-capture',
      sourceMetadata: { origin: 'createHoldingWithEvent', source: 'manual' },
    });
    return made;
  });
  await Container.get(FoundationClassificationService).classify({
    apply: true,
    userId: owner.userId,
  });
  return holding;
}

const run = (input: { userId: string; accountId: string; source: string; since?: Date }) =>
  new TransactionImportCoordinator().execute(input);

const coin = (sym: string, name = sym) => ({ symbol: sym, name });

/**
 * The main fixture: an IBKR-shaped ledger, whose trades are one row each and
 * get their cash side derived (SC-1453), into an account that already holds
 * one of the traded tokens by hand.
 */
async function brokerLedger() {
  const owner = await seed();
  const manualToken = await catalogToken('Manual coin');
  const manual = await manualHolding(owner, manualToken.id, '5');
  const cash = symbol('C');
  const cash2 = symbol('D');
  const stock = symbol('S');
  created.symbols.push(cash, cash2, stock);
  const fiat = (sym: string, quantity: string) => ({
    tokenIdentity: coin(sym),
    quantity,
    tokenType: 'fiat',
  });
  const events: TransactionEvent[] = [
    { externalId: 'dep-1', occurredAt: at(1), kind: 'deposit', primary: fiat(cash, '10000') },
    {
      externalId: 'buy-1',
      occurredAt: at(2),
      kind: 'buy',
      primary: { tokenIdentity: coin(manualToken.symbol, 'Manual coin'), quantity: '2' },
      counter: fiat(cash, '-1000'),
      fee: fiat(cash, '-1'),
      priceNative: { value: '500', quoteIdentity: coin(cash), tokenType: 'fiat' },
    },
    {
      externalId: 'buy-2',
      occurredAt: at(3),
      kind: 'buy',
      primary: { tokenIdentity: coin(stock), quantity: '10', tokenType: 'stock' },
      counter: fiat(cash, '-2000'),
      fee: { tokenIdentity: coin(stock), quantity: '-0.1', tokenType: 'stock' },
      priceNative: { value: '200', quoteIdentity: coin(cash), tokenType: 'fiat' },
    },
    {
      externalId: 'sell-1',
      occurredAt: at(4),
      kind: 'sell',
      primary: { tokenIdentity: coin(stock), quantity: '-4', tokenType: 'stock' },
      counter: fiat(cash, '900'),
      priceNative: { value: '225', quoteIdentity: coin(cash), tokenType: 'fiat' },
    },
    // A conversion reported as both of its sides (SC-1452): only its commission is added.
    {
      externalId: 'fx-1',
      occurredAt: at(5),
      kind: 'buy',
      primary: fiat(cash2, '500'),
      counter: fiat(cash, '-545'),
      fee: fiat(cash, '-2'),
    },
    {
      externalId: 'fx-1:quote',
      occurredAt: at(5),
      kind: 'sell',
      primary: fiat(cash, '-545'),
      counter: fiat(cash2, '500'),
    },
    // One event sent twice: the upsert merges it and the summary says so (SC-349).
    { externalId: 'dup-1', occurredAt: at(6), kind: 'deposit', primary: fiat(cash, '50') },
    { externalId: 'dup-1', occurredAt: at(6), kind: 'deposit', primary: fiat(cash, '50') },
    { externalId: 'wd-1', occurredAt: at(7), kind: 'withdraw', primary: fiat(cash, '-100') },
  ];
  serve({ institutionCode: 'ibkr', events });
  return { owner, manual, manualToken, cash, cash2, stock, events };
}

const mergeWarning = (cashHoldingId: string) =>
  `ibkr-api: 1 transaction row(s) across 1 dedup key(s) shared (holding, source, externalId) with another row in the same batch and were merged into one. Keys: ${cashHoldingId}/dup-1 If this source's externalId is not unique per event, those rows are lost.`;

/** Every holding of the account, named: `manual`, or its token's symbol. */
async function namedHoldings(accountId: string, manualId: string | null) {
  const accountHoldings = await holdingsOf(accountId);
  const tokens = await getDb()
    .select()
    .from(schema.tokens)
    .where(
      inArray(
        schema.tokens.id,
        accountHoldings.map((h) => h.tokenId)
      )
    );
  const symbolOf = new Map(tokens.map((t) => [t.id, t.symbol]));
  const names = new Map(
    accountHoldings.map((h) => [
      h.id,
      h.id === manualId ? 'manual' : (symbolOf.get(h.tokenId) ?? h.tokenId),
    ])
  );
  const name = (holdingId: string) => names.get(holdingId) ?? holdingId;
  const idOf = (holdingName: string) => {
    const found = accountHoldings.find((h) => name(h.id) === holdingName);
    if (!found) throw new Error(`the account holds no ${holdingName}`);
    return found.id;
  };
  return { accountHoldings, name, idOf };
}

async function readLedger(userId: string, name: (holdingId: string) => string) {
  const rows = await ledgerOf(userId);
  const externalIdOf = new Map(rows.map((r) => [r.id, r.externalId]));
  return rows.map((r) => ({
    externalId: r.externalId,
    holding: name(r.holdingId),
    kind: r.kind,
    quantity: r.quantity,
    source: r.source,
    settles: (r.sourceMetadata as { settles?: string }).settles ?? null,
    linkedTo: r.settlesTransactionId ? (externalIdOf.get(r.settlesTransactionId) ?? null) : null,
    swapGroupId: r.swapGroupId,
    inputId: r.inputId,
  }));
}

/** The price, counter and fee columns: tokens by symbol, `fee_of` by the row it names. */
async function readValuation(userId: string) {
  const rows = await ledgerOf(userId);
  const externalIdOf = new Map(rows.map((r) => [r.id, r.externalId]));
  const tokenIds = rows.flatMap((r) =>
    [r.priceNativeTokenId, r.counterTokenId, r.feeTokenId].filter((id) => id !== null)
  );
  const tokens = await getDb()
    .select()
    .from(schema.tokens)
    .where(inArray(schema.tokens.id, tokenIds));
  const symbolOf = (id: string | null) =>
    id === null ? null : (tokens.find((t) => t.id === id)?.symbol ?? id);
  return rows.map((r) => ({
    externalId: r.externalId,
    priceNative: r.priceNative,
    priceNativeToken: symbolOf(r.priceNativeTokenId),
    counterToken: symbolOf(r.counterTokenId),
    counterQuantity: r.counterQuantity,
    feeToken: symbolOf(r.feeTokenId),
    feeQuantity: r.feeQuantity,
    feeOf: r.feeOf === null ? null : (externalIdOf.get(r.feeOf) ?? r.feeOf),
  }));
}

const HISTORY_INSTANTS = [
  new Date(MANUAL_AT.getTime() - DAY_MS),
  new Date(at(1).getTime() - 3_600_000),
  new Date(at(2).getTime() + 12 * 3_600_000),
  new Date(at(5).getTime() + 12 * 3_600_000),
  new Date(at(7).getTime() + 3_600_000),
];

describe('TransactionImportCoordinator.execute — a broker ledger', () => {
  test('the rows, the legs, the holdings, the coverage, the summary and the history', async () => {
    const { owner, manual, cash, cash2, stock } = await brokerLedger();

    const result = await run({ ...owner, source: 'ibkr-api' });

    const { accountHoldings, name, idOf } = await namedHoldings(owner.accountId, manual.id);
    const warning = mergeWarning(idOf(cash));
    expect(result).toEqual({
      source: 'ibkr-api',
      accountId: owner.accountId,
      transactions: 14,
      observations: 0,
      firstEventAt: at(1).toISOString(),
      lastEventAt: at(7).toISOString(),
      // The opening the reconciler synthesized for the manual holding.
      earliestWrittenAt: '2026-05-19T23:59:59.999Z',
      hasCompleteTxHistory: true,
      warnings: [warning],
      warningDetails: [{ key: null, text: warning }],
      status: 'ok',
    });

    // A created holding is a feed position starting at its earliest row (D-4,
    // D-6), and the person's row the import's matching fell back to is now a
    // feed (the D-4 quirk, kept until A5). The three are created in one
    // transaction, so they share a `created_at` and are read by name.
    const order = ['manual', cash, stock, cash2];
    const createdHolding = { balance: '0', source: 'ingest-backfill', externalId: null };
    expect(
      accountHoldings
        .map((h) => ({
          holding: name(h.id),
          balance: h.balance,
          source: h.source,
          externalId: h.externalId,
          kind: h.kind,
          startsAt: h.startsAt,
        }))
        .sort((a, b) => order.indexOf(a.holding) - order.indexOf(b.holding))
    ).toEqual([
      {
        holding: 'manual',
        balance: '5',
        source: 'manual',
        externalId: null,
        kind: 'feed',
        startsAt: MANUAL_AT,
      },
      { holding: cash, ...createdHolding, kind: 'feed', startsAt: at(1) },
      { holding: stock, ...createdHolding, kind: 'feed', startsAt: at(3) },
      { holding: cash2, ...createdHolding, kind: 'feed', startsAt: at(5) },
    ]);

    // The run's one input, and the window it read (D-7, D-11).
    const [input, ...otherInputs] = await inputsOf(owner.accountId);
    if (!input) throw new Error('the run recorded no input');
    expect(otherInputs).toEqual([]);
    expect(input.source).toBe('ibkr-api');
    expect((await windowsOf(input.id)).map((w) => [w.fromAt, w.complete])).toEqual([[null, true]]);

    // Every imported row carries the input (D-5); the reconciler's opening does not.
    const inputId: string | null = input.id;
    const row = (
      externalId: string,
      holding: string,
      kind: string,
      quantity: string,
      settles: string | null = null
    ) => ({
      externalId,
      holding,
      kind,
      quantity,
      source: 'ibkr-api',
      settles,
      linkedTo: settles,
      swapGroupId: null,
      inputId,
    });
    expect(await readLedger(owner.userId, name)).toEqual([
      {
        ...row('opening_balance', 'manual', 'opening_balance', '3'),
        source: 'reconciliation-opening',
        inputId: null,
      },
      row('dep-1', cash, 'deposit', '10000'),
      row('buy-1', 'manual', 'buy', '2'),
      row('buy-1:fee', cash, 'fee', '-1', 'buy-1'),
      row('buy-1:settle', cash, 'settle_out', '-1000', 'buy-1'),
      row('buy-2', stock, 'buy', '10'),
      row('buy-2:settle', cash, 'settle_out', '-2000', 'buy-2'),
      row('sell-1', stock, 'sell', '-4'),
      row('sell-1:settle', cash, 'settle_in', '900', 'sell-1'),
      row('fx-1', cash2, 'buy', '500'),
      row('fx-1:fee', cash, 'fee', '-2', 'fx-1'),
      row('fx-1:quote', cash, 'sell', '-545'),
      row('dup-1', cash, 'deposit', '50'),
      row('wd-1', cash, 'withdraw', '-100'),
    ]);

    // Pinned after the move (Task 11 review M8). The same fixture read these
    // identical values off the pre-move code.
    const plain: Omit<Awaited<ReturnType<typeof readValuation>>[number], 'externalId'> = {
      priceNative: null,
      priceNativeToken: null,
      counterToken: null,
      counterQuantity: null,
      feeToken: null,
      feeQuantity: null,
      feeOf: null,
    };
    const valued = (externalId: string, values: Partial<typeof plain> = {}) => ({
      externalId,
      ...plain,
      ...values,
    });
    const trade = (price: string | null, counter: string, fee?: [string, string]) => ({
      priceNative: price,
      priceNativeToken: price === null ? null : cash,
      counterToken: cash,
      counterQuantity: counter,
      feeToken: fee?.[0] ?? null,
      feeQuantity: fee?.[1] ?? null,
    });
    expect(await readValuation(owner.userId)).toEqual([
      valued('opening_balance'),
      valued('dep-1'),
      valued('buy-1', trade('500', '-1000', [cash, '-1'])),
      valued('buy-1:fee', { feeOf: 'buy-1' }),
      valued('buy-1:settle'),
      valued('buy-2', trade('200', '-2000', [stock, '-0.1'])),
      valued('buy-2:settle'),
      valued('sell-1', trade('225', '900')),
      valued('sell-1:settle'),
      valued('fx-1', trade(null, '-545', [cash, '-2'])),
      valued('fx-1:fee', { feeOf: 'fx-1' }),
      valued('fx-1:quote', { counterToken: cash2, counterQuantity: '500' }),
      valued('dup-1'),
      valued('wd-1'),
    ]);

    const coverage = (holding: string, first: Date, last: Date, opening: string) => ({
      holding,
      txSources: ['ibkr-api'],
      hasCompleteTxHistory: true,
      firstTxAt: first,
      lastTxAt: last,
      historyStartsAt: null,
      openingBalanceQuantity: opening,
    });
    expect(
      (await coverageOf(accountHoldings.map((h) => h.id)))
        .map((c) => ({
          holding: name(c.holdingId),
          txSources: c.txSources,
          hasCompleteTxHistory: c.hasCompleteTxHistory,
          firstTxAt: c.firstTxAt,
          lastTxAt: c.lastTxAt,
          historyStartsAt: c.historyStartsAt,
          openingBalanceQuantity: c.openingBalanceQuantity,
        }))
        .sort(
          (a, b) =>
            [cash, cash2, 'manual', stock].indexOf(a.holding) -
            [cash, cash2, 'manual', stock].indexOf(b.holding)
        )
    ).toEqual([
      coverage(cash, at(1), at(7), '-7302'),
      coverage(cash2, at(5), at(5), '-500'),
      coverage('manual', new Date('2026-05-19T23:59:59.999Z'), at(2), '3'),
      coverage(stock, at(3), at(4), '-6'),
    ]);

    // Golden figures, recorded on the code before the move.
    const history = await captureHistory(order.map(idOf), HISTORY_INSTANTS);
    expect(history.map((h) => [name(h.holdingId), h.balance])).toEqual([
      ['manual', '2'],
      ['manual', '5'],
      ['manual', '5'],
      ['manual', '5'],
      ['manual', '5'],
      [cash, '0'],
      [cash, '0'],
      [cash, '1697'],
      [cash, '50'],
      [cash, '0'],
      [stock, '0'],
      [stock, '0'],
      [stock, '0'],
      [stock, '0'],
      [stock, '0'],
      [cash2, '0'],
      [cash2, '0'],
      [cash2, '0'],
      [cash2, '0'],
      [cash2, '0'],
    ]);
    await expectLabelsSettled(owner.userId);
  });

  test('the same events again, as the nightly incremental run, write nothing and claim nothing', async () => {
    const { owner, manual, cash } = await brokerLedger();
    await run({ ...owner, source: 'ibkr-api' });
    const { name, idOf } = await namedHoldings(owner.accountId, manual.id);
    const before = await ledgerOf(owner.userId);

    const result = await run({ ...owner, source: 'ibkr-api', since: at(1) });

    const warning = mergeWarning(idOf(cash));
    expect(result).toEqual({
      source: 'ibkr-api',
      accountId: owner.accountId,
      transactions: 14,
      observations: 0,
      firstEventAt: at(1).toISOString(),
      lastEventAt: at(7).toISOString(),
      earliestWrittenAt: null,
      hasCompleteTxHistory: false,
      warnings: [warning],
      warningDetails: [{ key: null, text: warning }],
      status: 'ok',
    });
    const after = await ledgerOf(owner.userId);
    expect(after.map((r) => [r.id, r.updatedAt, r.settlesTransactionId])).toEqual(
      before.map((r) => [r.id, r.updatedAt, r.settlesTransactionId])
    );
    // An incremental run asked for a window, so it leaves the full run's claim standing.
    const claims = await coverageOf([idOf(cash)]);
    expect(claims.map((c) => [name(c.holdingId), c.hasCompleteTxHistory])).toEqual([[cash, true]]);
  });
});

describe('TransactionImportCoordinator.execute — a wallet the user reviewed', () => {
  test('a kept token lands, an unkept one is skipped and counted, and a half swap becomes a transfer', async () => {
    const owner = await seed({ chainId: '1', walletAddress: 'synthetic-wallet-a' });
    const kept = await catalogToken('Kept coin');
    const keptHolding = await getDb().transaction((tx) =>
      makeHolding(tx, {
        userId: owner.userId,
        accountId: owner.accountId,
        tokenId: kept.id,
        balance: '2',
        source: 'wallet-sync',
        externalId: `${kept.symbol}-wallet`,
      })
    );
    const spam = symbol('X');
    const dropped = symbol('Y');
    created.symbols.push(spam, dropped);
    serve({
      institutionCode: 'ethereum',
      events: [
        {
          externalId: 'in-1',
          occurredAt: at(1),
          kind: 'transfer_in',
          primary: { tokenIdentity: coin(kept.symbol, 'Kept coin'), quantity: '3' },
        },
        {
          externalId: 'spam-1',
          occurredAt: at(2),
          kind: 'transfer_in',
          primary: { tokenIdentity: coin(spam), quantity: '100' },
        },
        {
          externalId: 'sw-out',
          occurredAt: at(3),
          kind: 'swap_out',
          primary: { tokenIdentity: coin(kept.symbol, 'Kept coin'), quantity: '-1' },
          counter: { tokenIdentity: coin(dropped), quantity: '5' },
          priceNative: { value: '5', quoteIdentity: coin(dropped) },
          swapGroupKey: '1:sw',
        },
        {
          externalId: 'sw-in',
          occurredAt: at(3),
          kind: 'swap_in',
          primary: { tokenIdentity: coin(dropped), quantity: '5' },
          counter: { tokenIdentity: coin(kept.symbol, 'Kept coin'), quantity: '-1' },
          priceNative: { value: '0.2', quoteIdentity: coin(kept.symbol, 'Kept coin') },
          swapGroupKey: '1:sw',
        },
      ],
    });

    const result = await run({ ...owner, source: 'etherscan' });

    const orphan =
      'Recorded 1 swap leg(s) as plain transfers: the other side of the swap has no holding on this account, so nothing could be linked or priced.';
    const skipped =
      "Skipped 2 tx event(s) referencing 2 token(s) the user didn't keep during wallet review.";
    expect(result).toEqual({
      source: 'etherscan',
      accountId: owner.accountId,
      transactions: 2,
      observations: 0,
      firstEventAt: at(1).toISOString(),
      lastEventAt: at(3).toISOString(),
      earliestWrittenAt: at(1).toISOString(),
      hasCompleteTxHistory: true,
      warnings: [orphan, skipped],
      warningDetails: [
        { key: null, text: orphan },
        { key: null, text: skipped },
      ],
      status: 'ok',
    });
    const { name } = await namedHoldings(owner.accountId, null);
    expect(
      (await ledgerOf(owner.userId)).map((r) => ({
        externalId: r.externalId,
        holding: name(r.holdingId),
        kind: r.kind,
        quantity: r.quantity,
        swapGroupId: r.swapGroupId,
        counterTokenId: r.counterTokenId,
        priceNative: r.priceNative,
      }))
    ).toEqual([
      {
        externalId: 'in-1',
        holding: kept.symbol,
        kind: 'transfer_in',
        quantity: '3',
        swapGroupId: null,
        counterTokenId: null,
        priceNative: null,
      },
      {
        externalId: 'sw-out',
        holding: kept.symbol,
        kind: 'transfer_out',
        quantity: '-1',
        swapGroupId: null,
        counterTokenId: null,
        priceNative: null,
      },
    ]);
    expect((await holdingsOf(owner.accountId)).map((h) => h.id)).toEqual([keptHolding.id]);
    // The router created the demoted leg's counter before the demotion nulled
    // it. Ingest resolves a leg it will demote no counter (R33).
    expect((await tokensWithSymbol([spam, dropped])).map((t) => t.symbol)).toEqual([]);
  });
});

describe('TransactionImportCoordinator.execute — what a run tells the reader', () => {
  test('the horizon, a provider note, a failed identity and a merge, in that order and keyed', async () => {
    const owner = await seed();
    const good = symbol('G');
    const bad = symbol('B');
    created.symbols.push(good, bad);
    serve({
      institutionCode: 'binance',
      horizonMs: 5 * 365 * DAY_MS,
      noteWith: ['stub: an annotation lookup ran short'],
      events: [
        {
          externalId: 'g-1',
          occurredAt: at(1),
          kind: 'deposit',
          primary: { tokenIdentity: coin(good), quantity: '1' },
        },
        {
          externalId: 'g-1',
          occurredAt: at(1),
          kind: 'deposit',
          primary: { tokenIdentity: coin(good), quantity: '1' },
        },
        {
          externalId: 'b-1',
          occurredAt: at(2),
          kind: 'deposit',
          primary: { tokenIdentity: coin(bad), quantity: '1' },
        },
      ],
    });
    const identities = Container.get(TokenIdentityService);
    const findOrCreate = identities.findOrCreateByIdentity.bind(identities);
    const spy = spyOn(identities, 'findOrCreateByIdentity').mockImplementation(
      async (partial, transaction) => {
        if (partial.symbol === bad) throw new Error('upstream refused: 429');
        return await findOrCreate(partial, transaction);
      }
    );
    try {
      const result = await run({ ...owner, source: 'binance-api' });

      const { idOf } = await namedHoldings(owner.accountId, null);
      const merge = `binance-api: 1 transaction row(s) across 1 dedup key(s) shared (holding, source, externalId) with another row in the same batch and were merged into one. Keys: ${idOf(good)}/g-1 If this source's externalId is not unique per event, those rows are lost.`;
      expect({ ...result, warnings: undefined }).toEqual({
        source: 'binance-api',
        accountId: owner.accountId,
        transactions: 2,
        observations: 0,
        firstEventAt: at(1).toISOString(),
        lastEventAt: at(1).toISOString(),
        earliestWrittenAt: at(1).toISOString(),
        hasCompleteTxHistory: false,
        warnings: undefined,
        warningDetails: [
          {
            key: 'v3.jobs.notices.providerHorizon',
            params: { provider: 'stub', durationCount: 5, durationUnit: 'year' },
            text: 'stub: a run with no start date reaches 5 years back and no further — anything older than that was never fetched',
          },
          { key: null, text: 'stub: an annotation lookup ran short' },
          // Labelled by the symbol, once per asset (R35; Task 10 change 3).
          {
            key: 'v3.jobs.notices.tokenIdentityFailed',
            params: { identity: bad, error: 'upstream refused: 429' },
            text: `Failed to resolve token identity ${bad}: upstream refused: 429`,
          },
          { key: null, text: merge },
        ],
        status: 'ok',
      });
      expect(result.warnings).toEqual(result.warningDetails.map((d) => d.text));
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * Two rulings pinned below `execute` by Task 11, pinned here through it (Task
 * 11 review M8): `execute` runs ingest in its own transaction, after the pass
 * that resolves tokens before that transaction opens.
 */
describe('TransactionImportCoordinator.execute — a run with something it cannot place, or nothing', () => {
  const FAILING = sql`select 1 / 0`;

  // R37: one bad event is dropped with today's notice; the run lands.
  test("a holding that cannot be created skips its entries with today's notice and the run lands", async () => {
    const owner = await seed();
    const good = symbol('G');
    const bad = symbol('B');
    created.symbols.push(good, bad);
    serve({
      institutionCode: 'binance',
      events: [
        {
          externalId: 'g-1',
          occurredAt: at(1),
          kind: 'deposit',
          primary: { tokenIdentity: coin(good), quantity: '1' },
        },
        {
          externalId: 'b-1',
          occurredAt: at(2),
          kind: 'deposit',
          primary: { tokenIdentity: coin(bad), quantity: '2' },
        },
      ],
    });
    const message = await getDb()
      .transaction((tx) => tx.execute(FAILING))
      .then(
        () => 'no error',
        (error: unknown) => (error instanceof Error ? error.message : String(error))
      );
    const holdingRepository = Container.get(HoldingRepository);
    const create = holdingRepository.create.bind(holdingRepository);
    const spy = spyOn(holdingRepository, 'create').mockImplementation(
      async (values, transaction) => {
        if (!transaction) throw new Error('a holding insert outside a transaction');
        const [token] = await transaction
          .select()
          .from(schema.tokens)
          .where(eq(schema.tokens.id, values.tokenId));
        if (token?.symbol === bad) await transaction.execute(FAILING);
        return await create(values, transaction);
      }
    );
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run({ ...owner, source: 'binance-api' });
    } finally {
      spy.mockRestore();
    }

    const [badToken] = await tokensWithSymbol([bad]);
    const notice = `Failed to resolve holding for token ${badToken!.id}: ${message}`;
    expect({ status: result.status, transactions: result.transactions }).toEqual({
      status: 'ok',
      transactions: 1,
    });
    expect(result.warnings).toEqual([notice]);
    const { name } = await namedHoldings(owner.accountId, null);
    expect((await ledgerOf(owner.userId)).map((r) => [r.externalId, name(r.holdingId)])).toEqual([
      ['g-1', good],
    ]);
    const [input] = await inputsOf(owner.accountId);
    expect((await windowsOf(input!.id)).length).toBe(1);
  });

  // R39: a run that read nothing still read its window, so it records one.
  test('a zero-event run records its input and window', async () => {
    const owner = await seed();
    serve({ institutionCode: 'binance', events: [] });

    const result = await run({ ...owner, source: 'binance-api' });

    expect({ status: result.status, transactions: result.transactions }).toEqual({
      status: 'ok',
      transactions: 0,
    });
    const inputs = await inputsOf(owner.accountId);
    expect(inputs.map((i) => i.source)).toEqual(['binance-api']);
    const windows = await windowsOf(inputs[0]!.id);
    expect(windows.map((w) => [w.fromAt, w.complete])).toEqual([[null, true]]);
    expect(await ledgerOf(owner.userId)).toEqual([]);
  });

  // Foundation A3, Task 7: a bare symbol names the newest token that carries it.
  test('the provider is handed the fiat USD as its base, not a newer token named USD', async () => {
    const owner = await seed();
    const [fiat] = await getDb()
      .select({ id: schema.tokens.id })
      .from(schema.tokens)
      .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
      .where(sql`${schema.tokens.symbol} = 'USD' AND ${schema.tokenTypes.code} = 'fiat'`);
    const coin = await getDb().transaction((tx) =>
      makeToken(tx, { symbol: 'USD', name: 'A coin named USD' })
    );
    const bases: string[] = [];
    const provider: TransactionsProvider = {
      providerKey: 'stub',
      capabilities: ['transactions'],
      canFetchTransactions: (code: string) => code === 'binance',
      fetchTransactions: async (ctx) => {
        bases.push(ctx.baseCurrency.id);
        return [];
      },
    };
    const registry = new ProviderRegistry();
    registry.register(provider);
    Container.set(ProviderRegistry, registry);

    try {
      await run({ ...owner, source: 'binance-api' });
    } finally {
      // By id: `created.symbols` deletes by symbol, and would take the fiat too.
      await getDb().delete(schema.tokens).where(eq(schema.tokens.id, coin.id));
    }

    expect(fiat?.id).toBeDefined();
    expect(bases).toEqual([fiat?.id as string]);
  });
});

// R38: today an empty external id was written. The feed write refuses the
// whole batch before reading anything, and the job fails once (the processor
// classifies the refusal as unrecoverable).
describe('TransactionImportCoordinator.execute — a batch the feed write refuses', () => {
  test('an event with an empty external id fails the run, names the problem and writes nothing', async () => {
    const owner = await seed();
    const coinSymbol = symbol('E');
    created.symbols.push(coinSymbol);
    serve({
      institutionCode: 'kraken',
      events: [
        {
          externalId: 'dep-1',
          occurredAt: at(1),
          kind: 'deposit',
          primary: { tokenIdentity: coin(coinSymbol), quantity: '1' },
        },
        {
          externalId: '',
          occurredAt: at(2),
          kind: 'deposit',
          primary: { tokenIdentity: coin(coinSymbol), quantity: '2' },
        },
      ],
    });

    const failure = await run({ ...owner, source: 'kraken-api' }).then(
      () => null,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(FeedBatchRejected);
    expect((failure as FeedBatchRejected).problems.map((p) => p.code)).toEqual([
      'empty-external-id',
    ]);
    expect(await ledgerOf(owner.userId)).toEqual([]);
    expect(await holdingsOf(owner.accountId)).toEqual([]);
    expect(await inputsOf(owner.accountId)).toEqual([]);
  });

  // R57: one external id for two assets would keep only the last row under
  // the input's key, so the run fails whole, by count and not by id.
  test('one external id sent for two assets fails the run, counts it and writes nothing', async () => {
    const owner = await seed();
    const [first, second] = [symbol('F'), symbol('S')];
    created.symbols.push(first, second);
    serve({
      institutionCode: 'kraken',
      events: [
        {
          externalId: 'ledger-1',
          occurredAt: at(1),
          kind: 'deposit',
          primary: { tokenIdentity: coin(first), quantity: '1' },
        },
        {
          externalId: 'ledger-1',
          occurredAt: at(1),
          kind: 'withdraw',
          primary: { tokenIdentity: coin(second), quantity: '-2' },
        },
      ],
    });

    const failure = await run({ ...owner, source: 'kraken-api' }).then(
      () => null,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(FeedBatchRejected);
    expect((failure as Error).message).toBe(
      'feed batch rejected: duplicate-external-id (1 external id(s) are each sent for more than one asset or source, by 2 entries in all)'
    );
    expect(await ledgerOf(owner.userId)).toEqual([]);
    expect(await holdingsOf(owner.accountId)).toEqual([]);
    expect(await inputsOf(owner.accountId)).toEqual([]);
    expect(await tokensWithSymbol([first, second])).toEqual([]);
  });
});
