import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { SCAM_PROBABILITY_THRESHOLD } from '../../src/lib/constants';
import { HoldingRepository, ingestHoldingOrder } from '../../src/repositories/HoldingRepository';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution, makeUser } from '../../test/helpers/factories';
import { makeAccount, makeHolding, makeToken } from '../../test/helpers/factories-extra';

// HoldingRepository is the single most important table access in the app
// (every dashboard, allocation, and pricing path reads through it) and is
// exactly where the scam-filter vs. wallet-import-review tension plays
// out. These tests lock in the `includeScamTokens` contract — both default
// and overridden — and sanity-check the scam-probability boundary.

const repo = () => Container.get(HoldingRepository);

async function scaffold(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
  const user = await makeUser(tx);
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  return { user, institution, account };
}

describe('HoldingRepository', () => {
  test('findByUser returns visible, non-scam holdings', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const cleanToken = await makeToken(tx, { isScamProbability: 0 });
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: cleanToken.id,
      });
      const rows = await repo().findByUser(user.id, tx);
      expect(rows.length).toBe(1);
    });
  });

  test('findByUser filters out tokens past the scam threshold by default', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const scammy = await makeToken(tx, { isScamProbability: 1 });
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: scammy.id,
      });
      const rows = await repo().findByUser(user.id, tx);
      expect(rows.length).toBe(0);
    });
  });

  test('findByUserWithFullDetails includeScamTokens=true surfaces scam holdings', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const scammy = await makeToken(tx, { isScamProbability: 1 });
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: scammy.id,
      });

      // Default path hides it.
      const defaultResult = await repo().findByUserWithFullDetails(
        user.id,
        undefined,
        tx,
        false,
        false
      );
      expect(defaultResult.length).toBe(0);

      // Wallet-import review path — scam tokens stay visible with a badge.
      const withScam = await repo().findByUserWithFullDetails(user.id, undefined, tx, false, true);
      expect(withScam.length).toBe(1);
      expect(withScam[0]!.token.isScamProbability).toBe(1);
    });
  });

  test('scam filter boundary exactly at SCAM_PROBABILITY_THRESHOLD', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      // just under the threshold → still visible.
      const justUnder = await makeToken(tx, {
        isScamProbability: SCAM_PROBABILITY_THRESHOLD - 0.01,
      });
      const atThreshold = await makeToken(tx, { isScamProbability: SCAM_PROBABILITY_THRESHOLD });
      await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: justUnder.id });
      await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: atThreshold.id });
      const rows = await repo().findByUser(user.id, tx);
      expect(rows.length).toBe(1);
    });
  });

  test('findByUser excludes hidden holdings by default', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx);
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        isHidden: true,
      });
      expect((await repo().findByUser(user.id, tx)).length).toBe(0);
      expect((await repo().findByUser(user.id, tx, true)).length).toBe(1);
    });
  });

  test('getDistinctTokenIds returns unique set across holdings', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const t1 = await makeToken(tx);
      const t2 = await makeToken(tx);
      await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: t1.id });
      await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId: t2.id });
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: t1.id,
        balance: '200',
      });
      const ids = await repo().getDistinctTokenIds(tx);
      expect(ids).toContain(t1.id);
      expect(ids).toContain(t2.id);
      // No duplicates — t1 appears twice in holdings but once in the result.
      expect(ids.filter((id) => id === t1.id).length).toBe(1);
    });
  });
});

// SC-193. The Airwallex account held two USD holdings — one `manual` with a
// NULL externalId, one `import_airwallex` keyed on 'USD' — and the transaction
// ingester resolved between them with a `.limit(1)` and no ORDER BY. 73
// transactions split 48/25 across the two, the majority landing on the row the
// user maintains by hand.
describe('findForIngest — which holding an importer writes into', () => {
  async function twoHoldings(tx: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
    const { user, account } = await scaffold(tx);
    const token = await makeToken(tx, { isScamProbability: 0 });
    // The manual row is deliberately the OLDER one. Without the externalId
    // preference the ordering falls through to `createdAt ASC` and picks it
    // every time — so these tests fail deterministically if the preference is
    // removed, rather than depending on which uuid happens to sort first.
    const manual = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
      source: 'manual',
      externalId: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const imported = await makeHolding(tx, {
      userId: user.id,
      accountId: account.id,
      tokenId: token.id,
      source: 'import_airwallex',
      externalId: 'USD',
      createdAt: new Date('2026-06-01T00:00:00Z'),
    });
    return { user, account, token, manual, imported };
  }

  test('prefers the imported row over the manual one', async () => {
    await withTestDb(async (tx) => {
      const { user, account, token, imported } = await twoHoldings(tx);
      const found = await repo().findForIngest(account.id, token.id, user.id, tx);
      expect(found?.id).toBe(imported.id);
    });
  });

  test('falls back to the manual row when nothing was imported', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx, { isScamProbability: 0 });
      const manual = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        source: 'manual',
        externalId: null,
      });
      const found = await repo().findForIngest(account.id, token.id, user.id, tx);
      expect(found?.id).toBe(manual.id);
    });
  });

  // The failure mode was not "wrong row" but "different row each run", which
  // is why the production split reads as two blocks rather than as noise.
  test('returns the same row on repeated calls', async () => {
    await withTestDb(async (tx) => {
      const { user, account, token, imported } = await twoHoldings(tx);
      for (let i = 0; i < 5; i++) {
        const found = await repo().findForIngest(account.id, token.id, user.id, tx);
        expect(found?.id).toBe(imported.id);
      }
    });
  });

  // An ingester needs the row even when the user has hidden it, so unlike
  // `findByAccountAndToken` this lookup does not filter on isHidden.
  test('sees a hidden imported holding', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx, { isScamProbability: 0 });
      const hidden = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        source: 'import_airwallex',
        externalId: 'USD',
        isHidden: true,
      });
      const found = await repo().findForIngest(account.id, token.id, user.id, tx);
      expect(found?.id).toBe(hidden.id);
    });
  });

  // The ordering makes the choice deterministic; it does not make it safe.
  // Whichever row wins is decided by data that can change under the position
  // — delete the imported row and the next run re-ingests the whole history
  // onto the manual one, because `holding_tx_dedup` is per HOLDING and has
  // nothing to dedupe against there. SC-239 is that, unnoticed for months.
  // The warning is the only thing that says the hazard is live.
  test('warns, naming both candidates, when the position holds more than one row', async () => {
    await withTestDb(async (tx) => {
      const { user, account, token, imported, manual } = await twoHoldings(tx);
      const warnings: { context: Record<string, unknown>; message: string }[] = [];
      const instance = new HoldingRepository();
      // `logger` is protected so each repository owns its component name.
      // Swapping it is the only way to observe an emission that has no
      // effect on the return value.
      (
        instance as unknown as {
          logger: { warn: (context: Record<string, unknown>, message: string) => void };
        }
      ).logger = {
        warn: (context, message) => {
          warnings.push({ context, message });
        },
      };

      const found = await instance.findForIngest(account.id, token.id, user.id, tx);

      expect(found?.id).toBe(imported.id);
      expect(warnings.length).toBe(1);
      expect(warnings[0]?.context.chosenHoldingId).toBe(imported.id);
      expect(warnings[0]?.context.runnerUpHoldingId).toBe(manual.id);
      expect(warnings[0]?.context.userId).toBe(user.id);
    });
  });

  test('stays silent when the position holds exactly one row', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx, { isScamProbability: 0 });
      const only = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        source: 'import_airwallex',
        externalId: 'USD',
      });
      let warned = 0;
      const instance = new HoldingRepository();
      (instance as unknown as { logger: { warn: () => void } }).logger = {
        warn: () => {
          warned += 1;
        },
      };

      const found = await instance.findForIngest(account.id, token.id, user.id, tx);

      expect(found?.id).toBe(only.id);
      expect(warned).toBe(0);
    });
  });

  test('two imported rows resolve deterministically, oldest first', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx, { isScamProbability: 0 });
      const older = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        source: 'import_airwallex',
        externalId: 'USD',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        source: 'import_airwallex',
        externalId: 'USD2',
        createdAt: new Date('2026-06-01T00:00:00Z'),
      });
      const found = await repo().findForIngest(account.id, token.id, user.id, tx);
      expect(found?.id).toBe(older.id);
    });
  });

  // THE regression guard, and the behavioural tests above are not.
  // Deleting the ordering leaves all of them green: on a two-row fixture
  // Postgres returns the imported row regardless, so the broken query gives
  // the right answer at test scale and the wrong one 25 times in 73 in
  // production. Verified by removing the ordering and re-running — 12 passed.
  test('the ingest ordering prefers a non-null externalId', () => {
    const order = ingestHoldingOrder();
    expect(order.length).toBe(3);
    // Drizzle's `sql` objects are cyclic, so read the chunk list rather than
    // serialising: [['']], 'external_id', [' is null'].
    const chunks = (order[0] as { queryChunks: unknown[] }).queryChunks;
    const rendered = chunks
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        // StringChunk carries `.value` (a string[]); a Column carries `.name`.
        const part = chunk as { value?: string[]; name?: string };
        if (Array.isArray(part.value)) return part.value.join('');
        return part.name ?? '';
      })
      .join('');
    expect(rendered).toContain('external_id');
    expect(rendered).toContain('is null');
  });

  test('findByAccountAndToken is deterministic too', async () => {
    await withTestDb(async (tx) => {
      const { user, account } = await scaffold(tx);
      const token = await makeToken(tx, { isScamProbability: 0 });
      const older = await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      await makeHolding(tx, {
        userId: user.id,
        accountId: account.id,
        tokenId: token.id,
        createdAt: new Date('2026-06-01T00:00:00Z'),
      });
      for (let i = 0; i < 5; i++) {
        const found = await repo().findByAccountAndToken(
          account.id,
          token.id,
          user.id,
          undefined,
          tx
        );
        expect(found?.id).toBe(older.id);
      }
    });
  });
});
