import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { UNMATCHED_TOKEN_MARKER } from '@scani/domain/services';
import {
  dropPricesOf,
  makeAccount,
  makeHolding,
  makeInstitution,
  makeInstitutionType,
  makeToken,
  makeUser,
  restoreContainerAfterAll,
} from '@scani/domain/test-helpers';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { makeAuthedCaller } from '../../helpers/test-caller';

// `portfolio.getDataQualityReport` (foundation A3, Task 17): "no recent price"
// is the engine's one definition (D-13) — a positive balance that
// `PriceReader` leaves unpriced or stale in the reader's base, and that is
// not unpriceable. It was "no row in any base newer than 7 days", a window no
// asset class is held to.
//
// The report reads through the global connection, so this commits its own
// rows and removes them.

restoreContainerAfterAll();

const HOUR = 3_600_000;
const db = () => getDb();
const made = { users: [] as string[], tokens: [] as string[], institutions: [] as string[] };

let user: typeof schema.users.$inferSelect;
let accountId: string;
let usdId: string;

async function typeId(code: string): Promise<string> {
  const [row] = await db()
    .select({ id: schema.tokenTypes.id })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, code));
  if (!row) throw new Error(`fixture: the ${code} token type is seeded by migration`);
  return row.id;
}

/** A holding of 1 of a fresh token of `code`, priced by `prices` against the quote each names. */
async function hold(
  code: string,
  prices: Array<{ quoteId: string; ageHours: number; source: string }>
): Promise<string> {
  const type = await typeId(code);
  const token = await db().transaction((tx) => makeToken(tx, { typeId: type }));
  made.tokens.push(token.id);
  for (const p of prices) {
    await db()
      .insert(schema.tokenPrices)
      .values({
        tokenId: token.id,
        baseTokenId: p.quoteId,
        price: '3',
        timestamp: new Date(Date.now() - p.ageHours * HOUR),
        source: p.source,
      });
  }
  const holding = await db().transaction((tx) =>
    makeHolding(tx, { userId: user.id, accountId, tokenId: token.id, balance: '1' })
  );
  return holding.id;
}

beforeAll(async () => {
  const [usd] = await db()
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .innerJoin(schema.tokenTypes, eq(schema.tokens.typeId, schema.tokenTypes.id))
    .where(
      and(
        eq(schema.tokens.symbol, 'USD'),
        eq(schema.tokenTypes.code, 'fiat'),
        isNull(schema.tokens.marketSegment)
      )
    );
  if (!usd) throw new Error('fixture: no fiat USD');
  usdId = usd.id;
  user = await db().transaction((tx) => makeUser(tx, { baseCurrencyId: usdId }));
  made.users.push(user.id);
  const account = await db().transaction(async (tx) => {
    // Upserted onto a seeded code, so no institution type outlives the test.
    const type = await makeInstitutionType(tx, { code: 'crypto_exchange' });
    const institution = await makeInstitution(tx, { typeId: type.id });
    made.institutions.push(institution.id);
    return makeAccount(tx, { userId: user.id, institutionId: institution.id });
  });
  accountId = account.id;
});

afterAll(async () => {
  await db().delete(schema.users).where(inArray(schema.users.id, made.users));
  await dropPricesOf(made.tokens);
  await db().delete(schema.tokens).where(inArray(schema.tokens.id, made.tokens));
  await db().delete(schema.institutions).where(inArray(schema.institutions.id, made.institutions));
});

describe('portfolio.getDataQualityReport — no recent price', () => {
  test('a crypto holding priced three days ago is flagged no recent price', async () => {
    const holdingId = await hold('crypto', [{ quoteId: usdId, ageHours: 72, source: 'coingecko' }]);

    const report = await makeAuthedCaller(user).portfolio.getDataQualityReport();

    expect(report.flagged.noRecentPrice).toContain(holdingId);
  });

  test('a custom token with a year-old manual price is not flagged', async () => {
    const holdingId = await hold('private-company', [
      { quoteId: usdId, ageHours: 365 * 24, source: 'manual' },
    ]);

    const report = await makeAuthedCaller(user).portfolio.getDataQualityReport();

    expect(report.flagged.noRecentPrice).not.toContain(holdingId);
  });

  test('CONTROL: a token priced only in another base is priced', async () => {
    // A currency of the test's own, worth 2 USD by a current rate.
    const quote = await db().transaction(async (tx) =>
      makeToken(tx, { typeId: await typeId('fiat') })
    );
    made.tokens.push(quote.id);
    await db()
      .insert(schema.tokenPrices)
      .values({
        tokenId: quote.id,
        baseTokenId: usdId,
        price: '2',
        timestamp: new Date(Date.now() - HOUR),
        source: 'frankfurter',
      });
    const holdingId = await hold('crypto', [
      { quoteId: quote.id, ageHours: 1, source: 'coingecko' },
    ]);

    const report = await makeAuthedCaller(user).portfolio.getDataQualityReport();

    expect(report.flagged.noRecentPrice).not.toContain(holdingId);
    expect(report.flagged.noPriceSource).not.toContain(holdingId);
  });
});

// A5 #9: a hide is the owner's and sticks, so a feed that later reports money
// on a hidden row would put it outside every total unseen. The report names
// such a row: hidden by its owner, priced, and holding more than it was hidden
// at. A row hidden before that figure was recorded is measured from zero.
describe('portfolio.getDataQualityReport — a hidden holding with a new balance (A5 #9)', () => {
  async function hidden(fields: {
    balance: string;
    hiddenBy: 'user' | 'auto' | null;
    hiddenBalance: string | null;
    valueBase: string | null;
  }): Promise<string> {
    const type = await typeId('crypto');
    const token = await db().transaction((tx) => makeToken(tx, { typeId: type }));
    made.tokens.push(token.id);
    const holding = await db().transaction((tx) =>
      makeHolding(tx, {
        userId: user.id,
        accountId,
        tokenId: token.id,
        source: 'import_ibkr',
        kind: 'feed',
        balance: fields.balance,
        isHidden: true,
        hiddenBy: fields.hiddenBy,
        hiddenBalance: fields.hiddenBalance,
        valueBase: fields.valueBase,
        valuePricedAt: fields.valueBase === null ? null : new Date(),
      })
    );
    return holding.id;
  }

  test('a row its owner hid at 0 that now holds money is listed', async () => {
    const id = await hidden({
      balance: '5',
      hiddenBy: 'user',
      hiddenBalance: '0',
      valueBase: '15',
    });
    const report = await makeAuthedCaller(user).portfolio.getDataQualityReport();
    expect(report.hiddenWithNewBalance).toContain(id);
  });

  test('a row hidden before its hide-time balance was recorded is measured from zero', async () => {
    const id = await hidden({
      balance: '5',
      hiddenBy: 'user',
      hiddenBalance: null,
      valueBase: '15',
    });
    const report = await makeAuthedCaller(user).portfolio.getDataQualityReport();
    expect(report.hiddenWithNewBalance).toContain(id);
  });

  test('CONTROL: a row holding what it was hidden at is not listed', async () => {
    const id = await hidden({
      balance: '5',
      hiddenBy: 'user',
      hiddenBalance: '5',
      valueBase: '15',
    });
    const report = await makeAuthedCaller(user).portfolio.getDataQualityReport();
    expect(report.hiddenWithNewBalance).toBeArray();
    expect(report.hiddenWithNewBalance).not.toContain(id);
  });

  test('a row the closed-position sweep hid is not listed: it already counts', async () => {
    const id = await hidden({
      balance: '5',
      hiddenBy: 'auto',
      hiddenBalance: null,
      valueBase: '15',
    });
    const report = await makeAuthedCaller(user).portfolio.getDataQualityReport();
    expect(report.hiddenWithNewBalance).toBeArray();
    expect(report.hiddenWithNewBalance).not.toContain(id);
  });

  test('a row nothing prices is not listed: its balance is not known to be money', async () => {
    const id = await hidden({
      balance: '5',
      hiddenBy: 'user',
      hiddenBalance: '0',
      valueBase: null,
    });
    const report = await makeAuthedCaller(user).portfolio.getDataQualityReport();
    expect(report.hiddenWithNewBalance).toBeArray();
    expect(report.hiddenWithNewBalance).not.toContain(id);
  });
});

// SC-1649 Q3: a restore never refuses a whole file for a token this instance
// lacks. It restores the holding on a token of the person's own, keeping the
// file's symbol and marked, and the report names that holding so it is seen.
describe('portfolio.getDataQualityReport — a token a restore could not match (SC-1649)', () => {
  async function heldOn(token: { createdByUserId: string | null; marked: boolean }) {
    const made_ = await db().transaction(async (tx) =>
      makeToken(tx, {
        typeId: await typeId('crypto'),
        createdByUserId: token.createdByUserId,
        providerMetadata: token.marked
          ? { provider: 'manual', [UNMATCHED_TOKEN_MARKER]: true }
          : { provider: 'manual' },
      })
    );
    made.tokens.push(made_.id);
    const holding = await db().transaction((tx) =>
      makeHolding(tx, { userId: user.id, accountId, tokenId: made_.id, balance: '1' })
    );
    return holding.id;
  }

  test('a holding on a marked token of the reader own is flagged', async () => {
    const id = await heldOn({ createdByUserId: user.id, marked: true });
    const report = await makeAuthedCaller(user).portfolio.getDataQualityReport();
    expect(report.flagged.restoredUnmatched).toContain(id);
    expect(report.holdings.restoredUnmatched).toBe(report.flagged.restoredUnmatched.length);
  });

  test('CONTROL: a custom token of the reader own with no marker is not flagged', async () => {
    const id = await heldOn({ createdByUserId: user.id, marked: false });
    const report = await makeAuthedCaller(user).portfolio.getDataQualityReport();
    expect(report.flagged.restoredUnmatched).toBeArray();
    expect(report.flagged.restoredUnmatched).not.toContain(id);
  });

  test('a shared token carrying the marker is not flagged: only a restore of the reader own marks one', async () => {
    const id = await heldOn({ createdByUserId: null, marked: true });
    const report = await makeAuthedCaller(user).portfolio.getDataQualityReport();
    expect(report.flagged.restoredUnmatched).not.toContain(id);
  });
});
