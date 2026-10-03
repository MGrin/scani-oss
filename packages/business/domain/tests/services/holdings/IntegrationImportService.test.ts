/**
 * The integration import (W2) end to end against Postgres: the exchange, IBKR
 * and wallet imports all write through `IntegrationImportService.import`.
 * Nothing is stubbed except where a test says so, so every account, holding,
 * observation, error and figure asserted here is what the import wrote.
 *
 * Written against today's path before it moves onto `FeedIngestService`
 * (foundation A2 Task 15) and kept as its characterization.
 *
 * Fixtures are committed rather than rolled back: the import opens its own
 * transaction, and history reads committed rows.
 */

import { afterEach, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getDb } from '@scani/db';
import type { Institution } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import type { HoldingSnapshot } from '@scani/providers/core/types';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { AbsenceWriter } from '../../../src/services/feeds/AbsenceWriter';
import { HoldingCacheWriter } from '../../../src/services/feeds/HoldingCacheWriter';
import { HoldingResolver } from '../../../src/services/feeds/HoldingResolver';
import { FoundationClassificationService } from '../../../src/services/foundation/FoundationClassificationService';
import { HoldingService } from '../../../src/services/holdings/HoldingService';
import {
  type IntegrationImportOptions,
  IntegrationImportService,
  type IntegrationImportTarget,
} from '../../../src/services/holdings/IntegrationImportService';
import { TokenIdentityService } from '../../../src/services/tokens/TokenIdentityService';
import { resolveSnapshotTokenType } from '../../../src/use-cases/lib/resolveSnapshotTokenType';
import { makeInstitution, makeInstitutionType, makeUser } from '../../../test/helpers/factories';
import { makeAccount, makeHolding } from '../../../test/helpers/factories-extra';
import { captureHistory } from '../../../test/helpers/history-neutrality';
import { expectLabelsSettled } from '../../../test/helpers/labels-settled';

const DAY_MS = 86_400_000;
const T0 = new Date('2026-09-01T00:00:00Z');
const CAPTURED = new Date('2026-09-20T08:00:00Z');
const NOW = new Date('2026-09-25T12:00:00Z');
const UPDATE_ORIGIN = { origin: 'updateHoldingBalanceWithEvent' };

/** Unique per run, so committed tokens never meet another test's. */
const freshSymbol = (prefix: string) =>
  `${prefix}${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;

const created = { users: [] as string[], symbols: [] as string[], institutions: [] as string[] };
const restores: Array<{ mockRestore: () => void }> = [];

afterEach(async () => {
  setSystemTime();
  for (const spy of restores.splice(0)) spy.mockRestore();
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

const run = (targets: IntegrationImportTarget[], options: IntegrationImportOptions) =>
  Container.get(IntegrationImportService).import(targets, options);

async function typeIds(): Promise<Record<'crypto' | 'fiat' | 'stock', string>> {
  const rows = await getDb().select().from(schema.tokenTypes);
  const idOf = (code: string) => {
    const row = rows.find((r) => r.code === code);
    if (!row) throw new Error(`no token type ${code}; the seed migration has one`);
    return row.id;
  };
  return { crypto: idOf('crypto'), fiat: idOf('fiat'), stock: idOf('stock') };
}

async function accountTypeId(code: 'crypto' | 'investment'): Promise<string> {
  const [row] = await getDb()
    .select()
    .from(schema.accountTypes)
    .where(eq(schema.accountTypes.code, code));
  if (!row) throw new Error(`no account type ${code}; the seed migration has one`);
  return row.id;
}

/** The exchange import's options (`ImportExchangeAccountsUseCase`). */
async function exchangeOptions(userId: string, sourceTag: string) {
  const types = await typeIds();
  return {
    userId,
    baseCurrencyId: null,
    sourceTag,
    arrival: 'user_confirmed',
    zeroStaleHoldings: true,
    skipZeroBalances: true,
    cryptoTokenTypeId: types.crypto,
    tokenTypeMap: types,
    resolveTokenTypeId: (snapshot, fallback) => resolveSnapshotTokenType(snapshot, types, fallback),
    transactionName: 'importExchangeAccounts',
  } satisfies IntegrationImportOptions;
}

/** The IBKR import's options (`ImportIbkrAccountsUseCase`): zeros are positions. */
async function ibkrOptions(
  userId: string,
  postProcessTokenMapping?: IntegrationImportOptions['postProcessTokenMapping']
) {
  const types = await typeIds();
  return {
    userId,
    baseCurrencyId: null,
    sourceTag: 'import_ibkr',
    arrival: 'user_confirmed',
    zeroStaleHoldings: true,
    skipZeroBalances: false,
    cryptoTokenTypeId: types.stock,
    tokenTypeMap: { fiat: types.fiat, stock: types.stock },
    resolveTokenTypeId: (snapshot) =>
      resolveSnapshotTokenType(snapshot, { fiat: types.fiat, stock: types.stock }, types.stock),
    ...(postProcessTokenMapping ? { postProcessTokenMapping } : {}),
    transactionName: 'importIbkrAccounts',
  } satisfies IntegrationImportOptions;
}

/** The wallet import's options (`ImportWalletAddressUseCase.importFromReview`). */
async function walletOptions(userId: string) {
  const types = await typeIds();
  return {
    userId,
    baseCurrencyId: null,
    sourceTag: 'blockchain',
    arrival: 'user_confirmed',
    zeroStaleHoldings: false,
    cryptoTokenTypeId: types.crypto,
    tokenTypeMap: { crypto: types.crypto },
    resolveTokenTypeId: (_snapshot, fallback) => fallback,
    transactionName: 'importWallet',
    transactionTimeoutMs: 120_000,
  } satisfies IntegrationImportOptions;
}

interface Seeded {
  userId: string;
  institution: Institution;
  accountId: string;
}

/** A user, a fresh institution, and an exchange account keyed by `accountType`. */
async function seed(
  metadata: Record<string, unknown> = { accountType: 'SPOT' },
  institutionTypeCode = 'crypto_exchange'
): Promise<Seeded> {
  const seeded = await getDb().transaction(async (tx) => {
    const type = await makeInstitutionType(tx, { code: institutionTypeCode });
    const user = await makeUser(tx);
    const institution = await makeInstitution(tx, { typeId: type.id });
    const account = await makeAccount(tx, {
      userId: user.id,
      institutionId: institution.id,
      typeId: await accountTypeId('crypto'),
      metadata,
    });
    return { userId: user.id, institution, accountId: account.id };
  });
  created.users.push(seeded.userId);
  created.institutions.push(seeded.institution.id);
  return seeded;
}

/** A token the test owns, for a holding that exists before the import. */
async function token(symbol: string, typeId?: string) {
  created.symbols.push(symbol);
  const [row] = await getDb()
    .insert(schema.tokens)
    .values({ symbol, name: symbol, typeId: typeId ?? (await typeIds()).crypto })
    .returning();
  if (!row) throw new Error('tokens insert failed');
  return row;
}

/** A holding with today's sync observation behind it, at T0. */
async function holding(
  seeded: Seeded,
  fields: {
    tokenId: string;
    balance: string;
    source: string;
    externalId?: string | null;
    isHidden?: boolean;
    accountId?: string;
  }
) {
  return await getDb().transaction(async (tx) => {
    const row = await makeHolding(tx, {
      userId: seeded.userId,
      accountId: fields.accountId ?? seeded.accountId,
      tokenId: fields.tokenId,
      balance: fields.balance,
      source: fields.source,
      externalId: fields.externalId ?? null,
      isHidden: fields.isHidden ?? false,
      createdAt: T0,
      lastUpdated: T0,
    });
    await tx.insert(schema.holdingBalanceObservations).values({
      userId: seeded.userId,
      holdingId: row.id,
      balance: fields.balance,
      observedAt: T0,
      source: 'sync-capture',
      sourceMetadata: UPDATE_ORIGIN,
    });
    return row;
  });
}

/** A provider row: the key is its external id, so it is also the holding's. */
function snapshot(
  key: string,
  symbol: string,
  balance: string,
  extra: Partial<HoldingSnapshot> = {}
): HoldingSnapshot {
  created.symbols.push(symbol);
  return {
    externalId: key,
    balance,
    capturedAt: CAPTURED,
    tokenIdentity: { symbol, name: `${symbol} name` },
    ...extra,
  };
}

function target(
  seeded: Seeded,
  snapshots: HoldingSnapshot[],
  over: Partial<IntegrationImportTarget> = {}
): IntegrationImportTarget {
  return {
    institution: seeded.institution,
    accountInfo: { externalId: 'main', name: 'Main', accountType: 'SPOT' },
    snapshots,
    accountTypeId: '',
    ...over,
  };
}

const holdingsOf = (accountId: string) =>
  getDb()
    .select()
    .from(schema.holdings)
    .where(eq(schema.holdings.accountId, accountId))
    .orderBy(asc(schema.holdings.createdAt), asc(schema.holdings.id));

const holdingRow = async (holdingId: string) => {
  const [row] = await getDb()
    .select()
    .from(schema.holdings)
    .where(eq(schema.holdings.id, holdingId));
  if (!row) throw new Error(`holding ${holdingId} is gone`);
  return row;
};

const observationsOf = (holdingId: string) =>
  getDb()
    .select()
    .from(schema.holdingBalanceObservations)
    .where(eq(schema.holdingBalanceObservations.holdingId, holdingId))
    .orderBy(asc(schema.holdingBalanceObservations.observedAt));

const accountRow = async (accountId: string) => {
  const [row] = await getDb()
    .select()
    .from(schema.accounts)
    .where(eq(schema.accounts.id, accountId));
  if (!row) throw new Error(`account ${accountId} is gone`);
  return row;
};

const tokenBySymbol = async (symbol: string) =>
  (await getDb().select().from(schema.tokens).where(eq(schema.tokens.symbol, symbol)))[0] ?? null;

/** The legacy columns of an observation: what today's path writes and history reads. */
const legacyColumns = (o: typeof schema.holdingBalanceObservations.$inferSelect) => ({
  balance: o.balance,
  observedAt: o.observedAt,
  source: o.source,
  sourceMetadata: o.sourceMetadata,
  gapReview: o.gapReview,
  supersededAt: o.supersededAt,
});

describe('IntegrationImportService.import — the writes', () => {
  test("an existing position is updated and a new one created, each at the source's as-of", async () => {
    const seeded = await seed();
    const tag = 'import_characterize';
    const kept = await token(freshSymbol('KEPT'));
    const existing = await holding(seeded, {
      tokenId: kept.id,
      balance: '1',
      source: tag,
      externalId: 'KEPTKEY',
    });
    const newSymbol = freshSymbol('NEW');
    const metadataBefore = (await accountRow(seeded.accountId)).metadata;
    const before = new Date();

    const result = await run(
      [
        target(seeded, [
          snapshot('KEPTKEY', kept.symbol, '2'),
          snapshot('NEWKEY', newSymbol, '3', { capturedAt: new Date(Date.now() + DAY_MS) }),
        ]),
      ],
      await exchangeOptions(seeded.userId, tag)
    );
    const after = new Date();

    // The exchange account is adopted by its `accountType`, and no patch is made.
    expect(result.accounts).toEqual([
      {
        id: seeded.accountId,
        name: (await accountRow(seeded.accountId)).name,
        institutionId: seeded.institution.id,
        institutionName: seeded.institution.name,
        accountType: 'SPOT',
        externalId: 'main',
        metadata: { accountType: 'SPOT' },
      },
    ]);
    expect((await accountRow(seeded.accountId)).metadata).toEqual(metadataBefore);
    expect(result.errors).toEqual([]);

    const newToken = await tokenBySymbol(newSymbol);
    expect(newToken).not.toBeNull();
    expect(result.tokenIds).toEqual([kept.id, newToken!.id]);

    const rows = await holdingsOf(seeded.accountId);
    expect(rows.map((h) => h.id)[0]).toBe(existing.id);
    const updated = rows[0]!;
    const fresh = rows[1]!;
    expect(rows).toHaveLength(2);
    expect(updated.balance).toBe('2');
    expect(updated.lastUpdated >= before && updated.lastUpdated <= after).toBe(true);
    expect({
      tokenId: fresh.tokenId,
      balance: fresh.balance,
      source: fresh.source,
      arrival: fresh.arrival,
      externalId: fresh.externalId,
      label: fresh.label,
      isHidden: fresh.isHidden,
      hiddenBy: fresh.hiddenBy,
      isActive: fresh.isActive,
    }).toEqual({
      tokenId: newToken!.id,
      balance: '3',
      source: tag,
      arrival: 'user_confirmed',
      externalId: 'NEWKEY',
      label: null,
      isHidden: false,
      hiddenBy: null,
      isActive: true,
    });
    expect(fresh.lastUpdated >= before && fresh.lastUpdated <= after).toBe(true);

    // One observation per write: the update at the source's as-of, the create
    // at now because its as-of was in the future.
    const updatedObs = await observationsOf(existing.id);
    expect(updatedObs.map(legacyColumns)).toEqual([
      expect.objectContaining({ balance: '1', observedAt: T0 }),
      {
        balance: '2',
        observedAt: CAPTURED,
        source: 'sync-capture',
        sourceMetadata: UPDATE_ORIGIN,
        gapReview: null,
        supersededAt: null,
      },
    ]);
    const freshObs = await observationsOf(fresh.id);
    expect(freshObs).toHaveLength(1);
    expect(freshObs[0]!.observedAt >= before && freshObs[0]!.observedAt <= after).toBe(true);
    expect({ ...legacyColumns(freshObs[0]!), observedAt: null }).toEqual({
      balance: '3',
      observedAt: null,
      source: 'sync-capture',
      sourceMetadata: { origin: 'createHoldingWithEvent', source: tag },
      gapReview: null,
      supersededAt: null,
    });

    expect(result.holdings).toEqual([
      {
        id: existing.id,
        accountId: seeded.accountId,
        accountName: result.accounts[0]!.name,
        tokenId: kept.id,
        tokenSymbol: kept.symbol,
        tokenName: kept.name,
        tokenIconUrl: null,
        tokenIsNew: false,
        tokenScamProbability: 0,
        balance: '2',
        externalId: 'KEPTKEY',
        isHidden: false,
      },
      {
        id: fresh.id,
        accountId: seeded.accountId,
        accountName: result.accounts[0]!.name,
        tokenId: newToken!.id,
        tokenSymbol: newSymbol,
        tokenName: `${newSymbol} name`,
        tokenIconUrl: null,
        // The import never reports a token as new.
        tokenIsNew: false,
        tokenScamProbability: newToken!.isScamProbability ?? 0,
        balance: '3',
        externalId: 'NEWKEY',
        isHidden: false,
      },
    ]);
  });

  test('zero-stale reaches only the holdings with the import’s own source tag (Z2, D-4)', async () => {
    const seeded = await seed();
    const tag = 'import_characterize';
    const [reported, stale, alreadyZero, cron, manual, skippedZero, hidden] = await Promise.all(
      ['REP', 'STALE', 'ZERO', 'CRON', 'MAN', 'SKIP', 'HID'].map((p) => token(freshSymbol(p)))
    );
    const rows = {
      reported: await holding(seeded, {
        tokenId: reported!.id,
        balance: '1',
        source: tag,
        externalId: 'REPKEY',
      }),
      stale: await holding(seeded, {
        tokenId: stale!.id,
        balance: '5',
        source: tag,
        externalId: 'STALEKEY',
      }),
      alreadyZero: await holding(seeded, {
        tokenId: alreadyZero!.id,
        balance: '0',
        source: tag,
        externalId: 'ZEROKEY',
      }),
      cron: await holding(seeded, {
        tokenId: cron!.id,
        balance: '7',
        source: 'sync_exchange_balances',
      }),
      manual: await holding(seeded, { tokenId: manual!.id, balance: '9', source: 'manual' }),
      skippedZero: await holding(seeded, {
        tokenId: skippedZero!.id,
        balance: '4',
        source: tag,
        externalId: 'SKIPKEY',
      }),
      hidden: await holding(seeded, {
        tokenId: hidden!.id,
        balance: '6',
        source: tag,
        externalId: 'HIDKEY',
        isHidden: true,
      }),
    };
    const before = new Date();

    const result = await run(
      [
        target(seeded, [
          snapshot('REPKEY', reported!.symbol, '2'),
          // Reported at zero, so it is skipped and its holding is not stale.
          snapshot('SKIPKEY', skippedZero!.symbol, '0'),
        ]),
      ],
      await exchangeOptions(seeded.userId, tag)
    );
    const after = new Date();

    expect(result.errors).toEqual([]);
    const balance = async (id: string) => (await holdingRow(id)).balance;
    expect({
      reported: await balance(rows.reported.id),
      stale: await balance(rows.stale.id),
      alreadyZero: await balance(rows.alreadyZero.id),
      cron: await balance(rows.cron.id),
      manual: await balance(rows.manual.id),
      skippedZero: await balance(rows.skippedZero.id),
      hidden: await balance(rows.hidden.id),
    }).toEqual({
      reported: '2',
      stale: '0',
      alreadyZero: '0',
      cron: '7',
      manual: '9',
      skippedZero: '4',
      hidden: '0',
    });
    expect((await holdingRow(rows.hidden.id)).isHidden).toBe(true);

    for (const zeroed of [rows.stale, rows.hidden]) {
      const obs = await observationsOf(zeroed.id);
      expect(obs).toHaveLength(2);
      const zero = obs[1]!;
      expect(zero.observedAt >= before && zero.observedAt <= after).toBe(true);
      expect({ ...legacyColumns(zero), observedAt: null }).toEqual({
        balance: '0',
        observedAt: null,
        source: 'sync-capture',
        sourceMetadata: UPDATE_ORIGIN,
        gapReview: null,
        supersededAt: null,
      });
    }
    for (const untouched of [rows.alreadyZero, rows.cron, rows.manual, rows.skippedZero]) {
      expect(await observationsOf(untouched.id)).toHaveLength(1);
    }
    // A zero-stale zero is not one of the import's holdings.
    expect(result.holdings.map((h) => h.id)).toEqual([rows.reported.id]);
  });

  test('a re-import beside a cron-created row of the same token creates its own row (C1, carried to Task 16)', async () => {
    const seeded = await seed();
    const tag = 'import_characterize';
    const shared = await token(freshSymbol('DUP'));
    const cron = await holding(seeded, {
      tokenId: shared.id,
      balance: '7',
      source: 'sync_exchange_balances',
    });

    await run(
      [target(seeded, [snapshot('DUPKEY', shared.symbol, '7')])],
      await exchangeOptions(seeded.userId, tag)
    );

    const rows = await holdingsOf(seeded.accountId);
    expect(rows.map((h) => [h.source, h.externalId, h.balance])).toEqual([
      ['sync_exchange_balances', null, '7'],
      [tag, 'DUPKEY', '7'],
    ]);
    expect(await observationsOf(cron.id)).toHaveLength(1);
  });

  test('a manual row of the same token is left alone, and the import creates its own', async () => {
    const seeded = await seed();
    const tag = 'import_characterize';
    const shared = await token(freshSymbol('MANUAL'));
    const manual = await holding(seeded, { tokenId: shared.id, balance: '9', source: 'manual' });
    const manualBefore = await holdingRow(manual.id);

    await run(
      [target(seeded, [snapshot('MANKEY', shared.symbol, '2')])],
      await exchangeOptions(seeded.userId, tag)
    );

    const rows = await holdingsOf(seeded.accountId);
    expect(rows.map((h) => [h.source, h.externalId, h.balance])).toEqual([
      ['manual', null, '9'],
      [tag, 'MANKEY', '2'],
    ]);
    expect(await holdingRow(manual.id)).toEqual(manualBefore);
    expect(await observationsOf(manual.id)).toHaveLength(1);
  });

  test('a hidden holding reported at a nonzero balance is shown again; one reported at zero stays hidden', async () => {
    const seeded = await seed({ accountType: 'PORTFOLIO' }, 'broker');
    const shown = await token(freshSymbol('SHOWN'), (await typeIds()).stock);
    const stays = await token(freshSymbol('STAYS'), (await typeIds()).stock);
    const toShow = await holding(seeded, {
      tokenId: shown.id,
      balance: '1',
      source: 'import_ibkr',
      externalId: 'SHOWNKEY',
      isHidden: true,
    });
    const toKeep = await holding(seeded, {
      tokenId: stays.id,
      balance: '3',
      source: 'import_ibkr',
      externalId: 'STAYSKEY',
      isHidden: true,
    });
    await getDb()
      .update(schema.holdings)
      .set({ hiddenBy: 'auto' })
      .where(inArray(schema.holdings.id, [toShow.id, toKeep.id]));
    const before = new Date();

    const result = await run(
      [
        target(
          seeded,
          [snapshot('SHOWNKEY', shown.symbol, '5'), snapshot('STAYSKEY', stays.symbol, '0')],
          { accountInfo: { externalId: 'U1', name: 'IBKR', accountType: 'PORTFOLIO' } }
        ),
      ],
      await ibkrOptions(seeded.userId)
    );

    const shownRow = await holdingRow(toShow.id);
    const keptRow = await holdingRow(toKeep.id);
    // The unhide writes `is_hidden` and `last_updated` only: `hidden_by` stays.
    expect([shownRow.balance, shownRow.isHidden, shownRow.hiddenBy]).toEqual(['5', false, 'auto']);
    expect(shownRow.lastUpdated >= before).toBe(true);
    expect([keptRow.balance, keptRow.isHidden, keptRow.hiddenBy]).toEqual(['0', true, 'auto']);
    expect(result.holdings.map((h) => [h.id, h.balance, h.isHidden])).toEqual([
      [toShow.id, '5', false],
      [toKeep.id, '0', true],
    ]);
  });

  test('skipZeroBalances: a zero position makes no token and no holding; without it the zero is a position', async () => {
    const exchange = await seed();
    const exchangeZero = freshSymbol('EXZ');
    const exchangeResult = await run(
      [target(exchange, [snapshot('EXZKEY', exchangeZero, '0')])],
      await exchangeOptions(exchange.userId, 'import_characterize')
    );
    expect(await tokenBySymbol(exchangeZero)).toBeNull();
    expect(await holdingsOf(exchange.accountId)).toEqual([]);
    expect(exchangeResult.holdings).toEqual([]);
    expect(exchangeResult.tokenIds).toEqual([]);

    const broker = await seed({ accountType: 'PORTFOLIO' }, 'broker');
    const brokerZero = freshSymbol('IBZ');
    const brokerResult = await run(
      [
        target(broker, [snapshot('IBZKEY', brokerZero, '0')], {
          accountInfo: { externalId: 'U1', name: 'IBKR', accountType: 'PORTFOLIO' },
        }),
      ],
      await ibkrOptions(broker.userId)
    );
    const zeroToken = await tokenBySymbol(brokerZero);
    expect(zeroToken).not.toBeNull();
    const rows = await holdingsOf(broker.accountId);
    expect(rows.map((h) => [h.tokenId, h.balance, h.externalId])).toEqual([
      [zeroToken!.id, '0', 'IBZKEY'],
    ]);
    expect((await observationsOf(rows[0]!.id)).map(legacyColumns)).toEqual([
      {
        balance: '0',
        observedAt: CAPTURED,
        source: 'sync-capture',
        sourceMetadata: { origin: 'createHoldingWithEvent', source: 'import_ibkr' },
        gapReview: null,
        supersededAt: null,
      },
    ]);
    expect(brokerResult.tokenIds).toEqual([zeroToken!.id]);
  });

  test('a holding that fails is collected as an error, and the rest land', async () => {
    const seeded = await seed({ accountType: 'PORTFOLIO' }, 'broker');
    const [refused, broken, malformed, fine] = ['REF', 'BRK', 'MAL', 'FINE'].map(freshSymbol);
    const identities = Container.get(TokenIdentityService);
    const original = identities.findOrCreateByIdentity.bind(identities);
    restores.push(
      spyOn(identities, 'findOrCreateByIdentity').mockImplementation(async (partial, tx) => {
        if (partial.symbol === refused) throw new Error('identity refused');
        return await original(partial, tx);
      })
    );
    const parseError = (() => {
      try {
        JSON.parse('not json');
      } catch (error) {
        return (error as Error).message;
      }
    })();
    const accountInfo = { externalId: 'U1', name: 'IBKR', accountType: 'PORTFOLIO' };

    const result = await run(
      [
        target(
          seeded,
          [
            snapshot('REFKEY', refused!, '1'),
            snapshot('BRKKEY', broken!, '2'),
            snapshot('MALKEY', malformed!, '3', {
              tokenIdentity: {
                symbol: malformed!,
                name: malformed!,
                providerMetadata: 'not json' as never,
              },
            }),
            snapshot('FINEKEY', fine!, '4'),
          ],
          { accountInfo }
        ),
      ],
      await ibkrOptions(seeded.userId, async (mapping, _snapshot, holding) => {
        if (holding.symbol === broken) throw new Error('lookup broke');
        return mapping;
      })
    );

    expect(result.errors).toEqual([
      { accountInfo, error: `Failed to import ${refused}: identity refused` },
      { accountInfo, error: `Failed to import ${broken}: lookup broke` },
      { accountInfo, error: `Failed to import ${malformed}: ${parseError}` },
    ]);
    const fineToken = await tokenBySymbol(fine!);
    expect(result.tokenIds).toEqual([fineToken!.id]);
    const rows = await holdingsOf(seeded.accountId);
    expect(rows.map((h) => [h.externalId, h.balance])).toEqual([['FINEKEY', '4']]);
    expect(result.holdings.map((h) => h.externalId)).toEqual(['FINEKEY']);
  });

  test('a row that matches no snapshot is skipped, and its key still counts as reported', async () => {
    const seeded = await seed();
    const tag = 'import_characterize';
    const orphan = await token(freshSymbol('ORPH'));
    // The holding is keyed by the provider's own id, as the import keys it.
    const kept = await holding(seeded, {
      tokenId: orphan.id,
      balance: '8',
      source: tag,
      externalId: 'cg-orphan',
    });

    const result = await run(
      [
        target(seeded, [
          snapshot('ORPHKEY', orphan.symbol, '9', {
            tokenIdentity: {
              symbol: orphan.symbol,
              name: orphan.name,
              providerMetadata: { coingecko: { id: 'cg-orphan' } } as never,
            },
          }),
        ]),
      ],
      await exchangeOptions(seeded.userId, tag)
    );

    expect(result).toEqual({
      accounts: [expect.objectContaining({ id: seeded.accountId })],
      holdings: [],
      tokenIds: [],
      errors: [],
    });
    expect((await holdingRow(kept.id)).balance).toBe('8');
    expect(await observationsOf(kept.id)).toHaveLength(1);
  });
});

describe('IntegrationImportService.import — accounts', () => {
  test('a wallet chain creates its account, adopts one by id, and adopts one by name, each patched', async () => {
    const seeded = await seed(
      { keep: 'me', lastSync: '2026-01-01T00:00:00.000Z' },
      'crypto_wallet'
    );
    const byName = await getDb().transaction(async (tx) =>
      makeAccount(tx, {
        userId: seeded.userId,
        institutionId: seeded.institution.id,
        typeId: await accountTypeId('crypto'),
        name: 'Named Wallet',
        metadata: { other: 'kept' },
      })
    );
    const patch = (chainId: number) => ({
      walletAddress: 'wallet-address',
      chainId,
      chainName: seeded.institution.name,
      displayName: 'Mine',
      userWalletId: 'wallet-1',
      migrated: true,
    });
    const typeId = await accountTypeId('crypto');
    const exitedSymbol = freshSymbol('EXIT');
    const before = new Date();
    const updatedAtBefore = (await accountRow(seeded.accountId)).updatedAt;

    const result = await run(
      [
        target(seeded, [snapshot('EXITKEY', exitedSymbol, '0')], {
          accountInfo: {
            externalId: 'wallet-address',
            name: 'New Wallet',
            accountType: 'crypto',
            description: 'Crypto wallet',
          },
          accountTypeId: typeId,
          accountName: 'New Wallet',
          accountDescription: 'Crypto wallet',
          accountMetadataPatch: patch(1),
        }),
        target(seeded, [], {
          accountInfo: { externalId: seeded.accountId, name: 'Old', accountType: 'crypto' },
          accountTypeId: typeId,
          accountName: 'Old',
          preExistingAccountId: seeded.accountId,
          accountMetadataPatch: patch(1),
        }),
        target(seeded, [], {
          accountInfo: {
            externalId: 'wallet-address',
            name: 'Named Wallet',
            accountType: 'crypto',
          },
          accountTypeId: typeId,
          accountName: 'Named Wallet',
          accountMetadataPatch: patch(1),
        }),
      ],
      await walletOptions(seeded.userId)
    );
    const after = new Date();

    expect(result.errors).toEqual([]);
    const [createdAccount, adoptedById, adoptedByName] = result.accounts;
    expect([adoptedById!.id, adoptedByName!.id]).toEqual([seeded.accountId, byName.id]);

    const lastSyncOf = (metadata: unknown) => {
      const lastSync = new Date((metadata as { lastSync: string }).lastSync);
      expect(lastSync >= before && lastSync <= after).toBe(true);
      return (metadata as { lastSync: string }).lastSync;
    };
    const fresh = await accountRow(createdAccount!.id);
    expect({
      name: fresh.name,
      description: fresh.description,
      typeId: fresh.typeId,
      isActive: fresh.isActive,
      metadata: fresh.metadata,
    }).toEqual({
      name: 'New Wallet',
      description: 'Crypto wallet',
      typeId,
      isActive: true,
      metadata: { ...patch(1), lastSync: lastSyncOf(fresh.metadata) },
    });
    const adopted = await accountRow(seeded.accountId);
    expect(adopted.metadata).toEqual({
      keep: 'me',
      ...patch(1),
      lastSync: lastSyncOf(adopted.metadata),
    });
    expect(adopted.updatedAt > updatedAtBefore).toBe(true);
    const named = await accountRow(byName.id);
    expect(named.metadata).toEqual({
      other: 'kept',
      ...patch(1),
      lastSync: lastSyncOf(named.metadata),
    });

    // The exited position (SC-398) is a holding at zero in the new account.
    const exitedToken = await tokenBySymbol(exitedSymbol);
    const rows = await holdingsOf(createdAccount!.id);
    expect(rows.map((h) => [h.tokenId, h.balance, h.source, h.externalId])).toEqual([
      [exitedToken!.id, '0', 'blockchain', 'EXITKEY'],
    ]);
    expect(result.holdings.map((h) => [h.accountId, h.accountName, h.balance])).toEqual([
      [createdAccount!.id, 'New Wallet', '0'],
    ]);
  });

  test('a wallet import zeroes nothing it was not told about', async () => {
    const seeded = await seed({}, 'crypto_wallet');
    const stale = await token(freshSymbol('WSTALE'));
    const kept = await holding(seeded, {
      tokenId: stale.id,
      balance: '5',
      source: 'blockchain',
      externalId: 'WSTALEKEY',
    });

    await run(
      [
        target(seeded, [], {
          accountInfo: { externalId: seeded.accountId, name: 'W', accountType: 'crypto' },
          preExistingAccountId: seeded.accountId,
          accountMetadataPatch: { chainId: 1 },
        }),
      ],
      await walletOptions(seeded.userId)
    );

    expect((await holdingRow(kept.id)).balance).toBe('5');
    expect(await observationsOf(kept.id)).toHaveLength(1);
  });
});

describe('IntegrationImportService.import — history', () => {
  // The clock is held still, so the zero-stale zero and every "now" sit at
  // NOW and the readings below are exact.
  test('golden history: an update, a create and a zero-stale zero', async () => {
    const seeded = await seed();
    const tag = 'import_characterize';
    const [updated, zeroed] = [await token(freshSymbol('GUP')), await token(freshSymbol('GZERO'))];
    const createdSymbol = freshSymbol('GNEW');
    const rows = {
      updated: await holding(seeded, {
        tokenId: updated.id,
        balance: '10',
        source: tag,
        externalId: 'GUPKEY',
      }),
      zeroed: await holding(seeded, {
        tokenId: zeroed.id,
        balance: '5',
        source: tag,
        externalId: 'GZEROKEY',
      }),
    };

    setSystemTime(NOW);
    await run(
      [
        target(seeded, [
          snapshot('GUPKEY', updated.symbol, '12'),
          snapshot('GNEWKEY', createdSymbol, '3'),
        ]),
      ],
      await exchangeOptions(seeded.userId, tag)
    );
    const createdRow = (await holdingsOf(seeded.accountId)).find((h) => h.externalId === 'GNEWKEY');
    expect(createdRow).toBeDefined();

    const mid = (a: Date, b: Date) => new Date((a.getTime() + b.getTime()) / 2);
    const instants = [
      new Date(T0.getTime() - DAY_MS),
      T0,
      mid(T0, CAPTURED),
      CAPTURED,
      mid(CAPTURED, NOW),
      NOW,
    ];
    const readings = await captureHistory(
      [rows.updated.id, rows.zeroed.id, createdRow!.id],
      instants
    );
    expect(readings.map((r) => r.balance)).toEqual(GOLDEN);
  });
});

/**
 * Today's readings, holding-major: updated, zeroed, created, at the six
 * instants. The zeroed holding's unexplained drop is spread from its last
 * observation to the zero, which is why the zero's instant is part of the
 * figure.
 */
const GOLDEN: Array<string | null> = [
  ...['10', '10', '11', '12', '12', '12'],
  ...[
    '5',
    '5',
    '3.027210884353741496598639456',
    '1.054421768707482993197278912',
    '0.5272108843537414965986394558',
    '0',
  ],
  ...['3', '3', '3', '3', '3', '3'],
];

const inputsOf = (accountId: string) =>
  getDb().select().from(schema.feedInputs).where(eq(schema.feedInputs.accountId, accountId));

const windowsOf = (inputId: string) =>
  getDb()
    .select()
    .from(schema.feedInputWindows)
    .where(eq(schema.feedInputWindows.inputId, inputId));

/** What a write labels an observation with (A1's columns). */
const labels = (o: typeof schema.holdingBalanceObservations.$inferSelect) => ({
  role: o.role,
  authority: o.authority,
  inputId: o.inputId,
  cause: o.cause,
});

describe('IntegrationImportService.import — through FeedIngestService (A2 Task 15)', () => {
  test("the batch's input is the account's provider or wallet input", async () => {
    const seeded = await seed();
    const tag = 'import_characterize';
    const [providerInput] = await getDb()
      .insert(schema.feedInputs)
      .values({
        userId: seeded.userId,
        accountId: seeded.accountId,
        source: `provider:${seeded.institution.name.toLowerCase()}`,
      })
      .returning();
    const kept = await token(freshSymbol('IKEPT'));
    const existing = await holding(seeded, {
      tokenId: kept.id,
      balance: '1',
      source: tag,
      externalId: 'IKEPTKEY',
    });
    const before = new Date();

    await run(
      [
        target(seeded, [
          snapshot('IKEPTKEY', kept.symbol, '2'),
          snapshot('INEWKEY', freshSymbol('INEW'), '3'),
        ]),
      ],
      await exchangeOptions(seeded.userId, tag)
    );
    const after = new Date();

    expect((await inputsOf(seeded.accountId)).map((i) => i.id)).toEqual([providerInput!.id]);
    const fresh = (await holdingsOf(seeded.accountId)).find((h) => h.externalId === 'INEWKEY');
    const written = [
      (await observationsOf(existing.id))[1]!,
      (await observationsOf(fresh!.id))[0]!,
    ];
    const checkpointLabels = {
      role: 'checkpoint' as const,
      authority: 'provider' as const,
      inputId: providerInput!.id,
      cause: null,
    };
    expect(written.map(labels)).toEqual([checkpointLabels, checkpointLabels]);
    expect([fresh!.kind, fresh!.startsAt]).toEqual(['feed', CAPTURED]);

    const windows = await windowsOf(providerInput!.id);
    expect(windows).toHaveLength(1);
    const window = windows[0]!;
    expect([window.fromAt, window.complete, window.toAt]).toEqual([
      CAPTURED,
      false,
      window.fetchedAt,
    ]);
    expect(window.toAt >= before && window.toAt <= after).toBe(true);
  });

  test("a wallet chain's balances belong to its chain's wallet input", async () => {
    const seeded = await seed({}, 'crypto_wallet');
    const symbol = freshSymbol('WIN');

    await run(
      [
        target(seeded, [snapshot('WINKEY', symbol, '4')], {
          accountInfo: { externalId: seeded.accountId, name: 'W', accountType: 'crypto' },
          preExistingAccountId: seeded.accountId,
          accountMetadataPatch: { chainId: 1 },
        }),
      ],
      await walletOptions(seeded.userId)
    );

    const inputs = await inputsOf(seeded.accountId);
    expect(inputs.map((i) => [i.source, i.walletId, i.credentialId])).toEqual([
      ['etherscan', null, null],
    ]);
    const [row] = await holdingsOf(seeded.accountId);
    expect((await observationsOf(row!.id)).map((o) => o.inputId)).toEqual([inputs[0]!.id]);
  });

  /**
   * The connect creates the account here, so the input ingest creates for it,
   * with no credential or wallet, is linked once the import commits (R39).
   */
  test("the import links each account's input to the wallet it names, or to the exchange's credential (R39)", async () => {
    const chain = await seed({}, 'crypto_wallet');
    const [wallet] = await getDb()
      .insert(schema.userWallets)
      .values({
        userId: chain.userId,
        walletAddress: `0x${randomUUID().replace(/-/g, '')}`,
        institutionIds: [chain.institution.id],
      })
      .returning();
    const exchange = await seed();
    const [credential] = await getDb()
      .insert(schema.userIntegrationCredentials)
      .values({
        userId: exchange.userId,
        institutionId: exchange.institution.id,
        credentialsType: 'api_key',
        encryptedCredentials: { ciphertext: 'x', iv: 'x', tag: 'x' },
      })
      .returning();

    await run(
      [
        target(chain, [snapshot('WLINKKEY', freshSymbol('WLINK'), '4')], {
          accountInfo: { externalId: chain.accountId, name: 'W', accountType: 'crypto' },
          preExistingAccountId: chain.accountId,
          accountMetadataPatch: { chainId: 1, userWalletId: wallet!.id },
        }),
      ],
      await walletOptions(chain.userId)
    );
    await run(
      [target(exchange, [snapshot('XLINKKEY', freshSymbol('XLINK'), '2')])],
      await exchangeOptions(exchange.userId, 'import_characterize')
    );

    const linked = async (accountId: string) =>
      (await inputsOf(accountId)).map((i) => [i.source, i.walletId, i.credentialId, i.status]);
    expect(await linked(chain.accountId)).toEqual([['etherscan', wallet!.id, null, 'active']]);
    expect(await linked(exchange.accountId)).toEqual([
      [`provider:${exchange.institution.name.toLowerCase()}`, null, credential!.id, 'active'],
    ]);
  });

  test('zeros come from the absence block in immediate mode, and nothing writes through HoldingService', async () => {
    const seeded = await seed();
    const tag = 'import_characterize';
    const [reported, stale, skipped] = await Promise.all(
      ['AREP', 'ASTALE', 'ASKIP'].map((p) => token(freshSymbol(p)))
    );
    await holding(seeded, {
      tokenId: reported!.id,
      balance: '1',
      source: tag,
      externalId: 'AREPKEY',
    });
    const staleRow = await holding(seeded, {
      tokenId: stale!.id,
      balance: '5',
      source: tag,
      externalId: 'ASTALEKEY',
    });
    const absences = spyOn(Container.get(AbsenceWriter), 'apply');
    // The one balance write `HoldingService` still has.
    const legacyWrite = spyOn(Container.get(HoldingService), 'updateHoldingBalance');
    restores.push(absences, legacyWrite);

    await run(
      [
        target(seeded, [
          snapshot('AREPKEY', reported!.symbol, '2'),
          snapshot('ASKIPKEY', skipped!.symbol, '0'),
        ]),
      ],
      await exchangeOptions(seeded.userId, tag)
    );

    expect(absences).toHaveBeenCalledTimes(1);
    expect(absences.mock.calls[0]![0].batch.legacy.absence).toEqual({
      mode: 'immediate',
      guardEmptySnapshot: false,
      reportedKeys: ['AREPKEY', 'ASKIPKEY'],
    });
    expect(legacyWrite).not.toHaveBeenCalled();
    const [input] = await inputsOf(seeded.accountId);
    const zero = (await observationsOf(staleRow.id))[1]!;
    expect([zero.balance, ...Object.values(labels(zero))]).toEqual([
      '0',
      'checkpoint',
      'provider',
      input!.id,
      null,
    ]);
  });

  test('every write is labelled as the backfill would label it', async () => {
    const seeded = await seed();
    const tag = 'import_characterize';
    const [updated, zeroed] = [await token(freshSymbol('LUP')), await token(freshSymbol('LZERO'))];
    await holding(seeded, { tokenId: updated.id, balance: '1', source: tag, externalId: 'LUPKEY' });
    await holding(seeded, { tokenId: zeroed.id, balance: '5', source: tag, externalId: 'LZKEY' });
    await Container.get(FoundationClassificationService).classify({
      apply: true,
      userId: seeded.userId,
    });
    await expectLabelsSettled(seeded.userId);

    await run(
      [
        target(seeded, [
          snapshot('LUPKEY', updated.symbol, '2'),
          snapshot('LNEWKEY', freshSymbol('LNEW'), '3'),
        ]),
      ],
      await exchangeOptions(seeded.userId, tag)
    );

    await expectLabelsSettled(seeded.userId);
  });

  // R37's shape: one holding's database error costs that holding, where
  // today it aborted the import's one transaction and lost every account.
  test('a holding whose write fails in the database is collected as an error, and the rest commit', async () => {
    const seeded = await seed();
    const tag = 'import_characterize';
    const [bad, good] = [freshSymbol('DBAD'), freshSymbol('DGOOD')];
    const resolver = Container.get(HoldingResolver);
    const original = resolver.resolveFeedHolding.bind(resolver);
    restores.push(
      spyOn(resolver, 'resolveFeedHolding').mockImplementation(async (req, within) => {
        if (req.key === 'DBADKEY') await within.execute(sql`select 1 / 0`);
        return await original(req, within);
      })
    );

    const result = await run(
      [target(seeded, [snapshot('DBADKEY', bad, '1'), snapshot('DGOODKEY', good, '2')])],
      await exchangeOptions(seeded.userId, tag)
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.error.startsWith(`Failed to import ${bad}: `)).toBe(true);
    expect(result.errors[0]!.error).toContain('select 1 / 0');
    expect((await holdingsOf(seeded.accountId)).map((h) => [h.externalId, h.balance])).toEqual([
      ['DGOODKEY', '2'],
    ]);
    // The token resolved before the holding failed, so it is reported, as today.
    expect(result.tokenIds).toHaveLength(2);
    expect(result.holdings.map((h) => h.externalId)).toEqual(['DGOODKEY']);
  });
});

describe('IntegrationImportService.import — a target fails whole (R64)', () => {
  const STALE_SYNC = '2026-01-01T00:00:00.000Z';
  const ABORTED = /25P02|current transaction is aborted/;

  /**
   * Ingest's cache write fails for the account named `accountName`: in the
   * database unless `fail` says otherwise. It runs after the batch's input and
   * window are written.
   */
  function failCacheWriteOf(
    accountName: string,
    fail: (tx: Parameters<HoldingCacheWriter['apply']>[2]) => Promise<unknown> = (tx) =>
      tx.execute(sql`select 1 / 0`)
  ) {
    const writer = Container.get(HoldingCacheWriter);
    const original = writer.apply.bind(writer);
    restores.push(
      spyOn(writer, 'apply').mockImplementation(async (userId, writes, tx) => {
        const ids = writes.map((w) => w.holdingId);
        const owners =
          ids.length === 0
            ? []
            : await tx
                .select({ name: schema.accounts.name })
                .from(schema.holdings)
                .innerJoin(schema.accounts, eq(schema.accounts.id, schema.holdings.accountId))
                .where(inArray(schema.holdings.id, ids));
        if (owners.some((o) => o.name === accountName)) await fail(tx);
        return await original(userId, writes, tx);
      })
    );
  }

  /** Everything an import can write for the user, beyond what `seed` made. */
  async function writtenFor(seeded: Seeded) {
    const db = getDb();
    const accounts = await db
      .select({ id: schema.accounts.id })
      .from(schema.accounts)
      .where(eq(schema.accounts.userId, seeded.userId));
    const holdings = await db
      .select({ id: schema.holdings.id })
      .from(schema.holdings)
      .where(eq(schema.holdings.userId, seeded.userId));
    const inputs = await db
      .select({ id: schema.feedInputs.id })
      .from(schema.feedInputs)
      .where(eq(schema.feedInputs.userId, seeded.userId));
    const windows = await db
      .select({ id: schema.feedInputWindows.id })
      .from(schema.feedInputWindows)
      .innerJoin(schema.feedInputs, eq(schema.feedInputs.id, schema.feedInputWindows.inputId))
      .where(eq(schema.feedInputs.userId, seeded.userId));
    return {
      accounts: accounts.map((a) => a.id).filter((id) => id !== seeded.accountId),
      holdings: holdings.length,
      inputs: inputs.length,
      windows: windows.length,
    };
  }

  // What guards R64 in the tests below is each one's exact `errors` equality.
  // drizzle keeps the server's sentence only in `.cause`, and `result.errors`
  // carries messages alone, so a 25P02 victim shows up there as a `Failed
  // query:` naming an innocent statement. The `not.toMatch(ABORTED)` beside it
  // fires only on a statement postgres.js issues itself, unwrapped, such as a
  // `savepoint sN` in an aborted scope. This test proves only that the pattern
  // matches the server's own sentence, read off `.cause`.
  test('the aborted-transaction pattern matches the server’s own 25P02 sentence', async () => {
    let said = '';
    await getDb()
      .transaction(async (tx) => {
        await tx.execute(sql`select 1 / 0`).catch(() => undefined);
        await tx.execute(sql`select 1`).catch((error: unknown) => {
          said = String((error as { cause?: unknown }).cause ?? error);
        });
      })
      .catch(() => undefined);
    expect(said).toMatch(ABORTED);
  });

  test('a target whose ingest fails in the database keeps its account untouched, and the next target lands', async () => {
    const seeded = await seed({
      accountType: 'SPOT',
      lastSync: STALE_SYNC,
      balancesAsOf: { at: T0.toISOString(), note: 'statement' },
    });
    const other = await getDb().transaction(async (tx) =>
      makeAccount(tx, {
        userId: seeded.userId,
        institutionId: seeded.institution.id,
        typeId: await accountTypeId('crypto'),
        metadata: { accountType: 'MARGIN', lastSync: STALE_SYNC },
      })
    );
    const tag = 'import_characterize';
    const doomed = await token(freshSymbol('DOOM'));
    const doomedRow = await holding(seeded, {
      tokenId: doomed.id,
      balance: '1',
      source: tag,
      externalId: 'DOOMKEY',
    });
    const before = await accountRow(seeded.accountId);
    failCacheWriteOf(before.name);
    const doomedInfo = { externalId: 'spot', name: 'Spot', accountType: 'SPOT' };

    const result = await run(
      [
        target(seeded, [snapshot('DOOMKEY', doomed.symbol, '2')], {
          accountInfo: doomedInfo,
          accountMetadataPatch: { accountType: 'SPOT' },
        }),
        target(seeded, [snapshot('LANDKEY', freshSymbol('LAND'), '3')], {
          accountInfo: { externalId: 'margin', name: 'Margin', accountType: 'MARGIN' },
          accountMetadataPatch: { accountType: 'MARGIN' },
        }),
      ],
      await exchangeOptions(seeded.userId, tag)
    );

    // One error, for the target, carrying the database's own message.
    expect(result.errors).toEqual([
      { accountInfo: doomedInfo, error: expect.stringContaining('select 1 / 0') },
    ]);
    expect(result.errors.map((e) => e.error).join('\n')).not.toMatch(ABORTED);
    // The failed target's account reads as it did: no fresh lastSync or
    // balancesAsOf over balances that did not move (Task 15 review, I1).
    const after = await accountRow(seeded.accountId);
    expect({ metadata: after.metadata, updatedAt: after.updatedAt }).toEqual({
      metadata: before.metadata,
      updatedAt: before.updatedAt,
    });
    expect((await holdingRow(doomedRow.id)).balance).toBe('1');
    expect(await observationsOf(doomedRow.id)).toHaveLength(1);
    expect(result.accounts.map((a) => a.id)).toEqual([other.id]);
    // The control: the next target's patch and balance commit, so both reads
    // above see what a target that lands writes.
    const landed = (await accountRow(other.id)).metadata as Record<string, unknown>;
    expect(Object.keys(landed).sort()).toEqual(['accountType', 'lastSync']);
    expect(landed.lastSync).not.toBe(STALE_SYNC);
    expect((await holdingsOf(other.id)).map((h) => [h.externalId, h.balance])).toEqual([
      ['LANDKEY', '3'],
    ]);
  });

  test('a target whose ingest fails in the database creates no account, and the next target creates its own', async () => {
    const seeded = await seed();
    const tag = 'import_characterize';
    const typeId = await accountTypeId('crypto');
    failCacheWriteOf('Doomed');
    const doomedInfo = { externalId: 'futures', name: 'Doomed', accountType: 'FUTURES' };
    const doomedSymbol = freshSymbol('DNEW');

    const result = await run(
      [
        target(seeded, [snapshot('DNEWKEY', doomedSymbol, '2')], {
          accountInfo: doomedInfo,
          accountTypeId: typeId,
          accountMetadataPatch: { accountType: 'FUTURES' },
        }),
        target(seeded, [snapshot('LNEWKEY', freshSymbol('LNEW'), '3')], {
          accountInfo: { externalId: 'margin', name: 'Landed', accountType: 'MARGIN' },
          accountTypeId: typeId,
          accountMetadataPatch: { accountType: 'MARGIN' },
        }),
      ],
      await exchangeOptions(seeded.userId, tag)
    );

    expect(result.errors).toEqual([
      { accountInfo: doomedInfo, error: expect.stringContaining('select 1 / 0') },
    ]);
    expect(result.errors.map((e) => e.error).join('\n')).not.toMatch(ABORTED);
    // The control is 'Landed': the same read finds the account a target that lands creates.
    const names = (
      await getDb()
        .select({ name: schema.accounts.name })
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, seeded.userId))
    ).map((a) => a.name);
    expect(names).toContain('Landed');
    expect(names).not.toContain('Doomed');
    expect(result.accounts.map((a) => a.name)).toEqual(['Landed']);
    expect(await tokenBySymbol(doomedSymbol)).toBeNull();
    // The control for `writtenFor` below: it sees what a target that lands writes.
    expect(await writtenFor(seeded)).toEqual({
      accounts: result.accounts.map((a) => a.id),
      holdings: 1,
      inputs: 1,
      windows: 1,
    });
  });

  // Before per-target savepoints, postgres.js rejected such an import with the
  // first database error at commit, and the job retried it. An import that
  // landed nothing still does (R66).
  test('an import whose only target fails in the database rejects with that error and writes nothing', async () => {
    const seeded = await seed();
    const typeId = await accountTypeId('crypto');
    failCacheWriteOf('Doomed');
    const doomedSymbol = freshSymbol('DONLY');

    const rejection = await run(
      [
        target(seeded, [snapshot('DONLYKEY', doomedSymbol, '2')], {
          accountInfo: { externalId: 'futures', name: 'Doomed', accountType: 'FUTURES' },
          accountTypeId: typeId,
          accountMetadataPatch: { accountType: 'FUTURES' },
        }),
      ],
      await exchangeOptions(seeded.userId, 'import_characterize')
    ).then(
      () => null,
      (error: unknown) => error
    );

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toContain('select 1 / 0');
    expect((rejection as { cause?: { code?: unknown } }).cause?.code).toBe('22012');
    expect(await writtenFor(seeded)).toEqual({ accounts: [], holdings: 0, inputs: 0, windows: 0 });
    expect(await tokenBySymbol(doomedSymbol)).toBeNull();
  });

  // The control for the one above: an all-target failure the database did not
  // raise resolves with its per-target error, as before R66.
  test('an import whose only target fails outside the database resolves with that error and writes nothing', async () => {
    const seeded = await seed();
    const typeId = await accountTypeId('crypto');
    failCacheWriteOf('Doomed', async () => {
      throw new Error('cache write refused');
    });
    const doomedInfo = { externalId: 'futures', name: 'Doomed', accountType: 'FUTURES' };
    const doomedSymbol = freshSymbol('DPLAIN');

    const result = await run(
      [
        target(seeded, [snapshot('DPLAINKEY', doomedSymbol, '2')], {
          accountInfo: doomedInfo,
          accountTypeId: typeId,
          accountMetadataPatch: { accountType: 'FUTURES' },
        }),
      ],
      await exchangeOptions(seeded.userId, 'import_characterize')
    );

    expect(result).toEqual({
      accounts: [],
      holdings: [],
      tokenIds: [],
      errors: [{ accountInfo: doomedInfo, error: 'cache write refused' }],
    });
    expect(await writtenFor(seeded)).toEqual({ accounts: [], holdings: 0, inputs: 0, windows: 0 });
    expect(await tokenBySymbol(doomedSymbol)).toBeNull();
  });

  test("a database error in one row's preparation costs that row, and the rest of the target lands", async () => {
    const seeded = await seed({ accountType: 'PORTFOLIO' }, 'broker');
    const [bad, good] = ['PBAD', 'PGOOD'].map(freshSymbol);
    const accountInfo = { externalId: 'U1', name: 'IBKR', accountType: 'PORTFOLIO' };

    const result = await run(
      [
        target(seeded, [snapshot('PBADKEY', bad!, '1'), snapshot('PGOODKEY', good!, '2')], {
          accountInfo,
        }),
      ],
      // IBKR's prefix match reads the database inside the import's transaction.
      await ibkrOptions(seeded.userId, async (mapping, _snapshot, holding, _typeId, tx) => {
        if (holding.symbol === bad) await tx.execute(sql`select 1 / 0`);
        return mapping;
      })
    );

    expect(result.errors.map((e) => e.error).join('\n')).not.toMatch(ABORTED);
    expect(result.errors).toEqual([
      { accountInfo, error: expect.stringContaining('select 1 / 0') },
    ]);
    expect(result.errors[0]!.error.startsWith(`Failed to import ${bad}: `)).toBe(true);
    // The control: the row after the failed one lands, so the read sees a landed row.
    expect((await holdingsOf(seeded.accountId)).map((h) => [h.externalId, h.balance])).toEqual([
      ['PGOODKEY', '2'],
    ]);
    expect(result.holdings.map((h) => h.externalId)).toEqual(['PGOODKEY']);
  });
});
