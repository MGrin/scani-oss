/**
 * SC-296. The hourly `pricing` job ignored `unpriceable_until` entirely —
 * `UpdateTokenPricesUseCase` had zero references to it — so tokens the
 * nightly backfill had already established nobody quotes were re-asked every
 * hour, forever. On the 19:00Z run that produced the ticket, all 13 of its 13
 * "failures" were tokens marked at 08:19Z the same day: ~312 provider calls a
 * day, known in advance to return nothing, against providers we rate-limit
 * and circuit-break precisely because their budget is finite.
 *
 * **The predicate under test is the conjunction, not the flag.** In cooldown
 * AND never had a `token_prices` row — the same thing SC-146's
 * `findNeverPricedInCooldownTokenIds` already means everywhere else. A
 * flag-only filter would suppress a token that has prices but carries a stale
 * mark, and `tokenWithPrices` below is what fails if anyone simplifies it to
 * the flag.
 *
 * `TokenRepository` is deliberately REAL here: the conjunction is SQL, and a
 * stub of it would test the stub. What is stubbed is the discovery edge and
 * the provider edge —
 *
 *  - `HoldingQueryService.getDistinctTokenIds`, because this job is global and
 *    unscoped. Reading the real table would make every count below a fact
 *    about whatever else lives in the shared dev database, which is exactly
 *    how SC-272 cost two threads a day each.
 *  - `PricingService.getTokenPrices`, so no HTTP leaves the suite and so the
 *    test can assert *which tokens were asked about* — the actual claim.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import { TokenRepository } from '../../src/repositories/TokenRepository';
import { HoldingQueryService, PricingService, VaultService } from '../../src/services';
import { UpdateTokenPricesUseCase } from '../../src/use-cases/UpdateTokenPricesUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface Fixture {
  tokenTypeId: string;
  /** In cooldown, never priced — the one that must be suppressed. */
  suppressed: string;
  /** In cooldown but HAS a price row — the conjunction's other half. */
  withPrices: string;
  /** Cooldown expired yesterday, never priced. */
  expired: string;
  /** Never marked at all — a token added minutes ago looks like this. */
  fresh: string;
}

let fixture: Fixture | null = null;
/** Token ids the stubbed PricingService was actually asked about. */
let asked: string[] = [];

async function setupFixture(): Promise<Fixture> {
  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `sc296-${randomUUID().slice(0, 6)}`, name: 'SC296 Token Type' })
    .returning();
  if (!tokenType) throw new Error('token type insert failed');

  const mk = async (label: string, unpriceableUntil: Date | null): Promise<string> => {
    const [token] = await db
      .insert(schema.tokens)
      .values({
        symbol: `SC296${label}${randomUUID().toUpperCase()}`,
        name: `SC296 ${label}`,
        typeId: tokenType.id,
        unpriceableUntil,
      })
      .returning();
    if (!token) throw new Error(`token insert failed for ${label}`);
    return token.id;
  };

  const now = Date.now();
  const inCooldown = new Date(now + 6 * DAY);
  const f: Fixture = {
    tokenTypeId: tokenType.id,
    suppressed: await mk('SUP', inCooldown),
    withPrices: await mk('PRC', inCooldown),
    expired: await mk('EXP', new Date(now - DAY)),
    fresh: await mk('NEW', null),
  };

  // One stored price is all it takes to leave the conjunction — and it is how
  // a real token leaves it, because a successful fetch in this very job
  // writes one (`PricingProviderRouter` → `bulkUpsert`).
  await db.insert(schema.tokenPrices).values({
    tokenId: f.withPrices,
    baseTokenId: f.fresh,
    price: '1.25',
    timestamp: new Date(now - HOUR),
    source: 'sc296-test',
  });

  return f;
}

async function cleanupFixture(f: Fixture): Promise<void> {
  const ids = [f.suppressed, f.withPrices, f.expired, f.fresh];
  await db.delete(schema.tokenPrices).where(inArray(schema.tokenPrices.tokenId, ids));
  await db.delete(schema.tokenPrices).where(inArray(schema.tokenPrices.baseTokenId, ids));
  await db.delete(schema.tokens).where(inArray(schema.tokens.id, ids));
  await db.delete(schema.tokenTypes).where(inArray(schema.tokenTypes.id, [f.tokenTypeId]));
}

function makeUseCase(order: string[]): UpdateTokenPricesUseCase {
  Container.set(HoldingQueryService, {
    getDistinctTokenIds: async () => order,
    // The use case reads holdings for the vault/realtime steps; both are
    // wrapped in try/catch, and an empty list is the honest answer here.
    getHoldingsForTokens: async () => [],
  } as unknown as HoldingQueryService);

  Container.set(PricingService, {
    getTokenPrices: async (tokens: Array<{ id: string }>) => {
      asked = tokens.map((token) => token.id);
      return new Map(tokens.map((token) => [token.id, '100']));
    },
  } as unknown as PricingService);

  Container.set(VaultService, {
    recalculateVaultsForToken: async () => undefined,
  } as unknown as VaultService);

  // Real, on purpose — the conjunction is SQL.
  Container.set(TokenRepository, new TokenRepository());

  const instance = new UpdateTokenPricesUseCase();
  Container.set(UpdateTokenPricesUseCase, instance);
  return instance;
}

beforeEach(async () => {
  asked = [];
  fixture = await setupFixture();
});

afterEach(async () => {
  if (fixture) await cleanupFixture(fixture);
  fixture = null;
});

afterAll(async () => {
  if (fixture) await cleanupFixture(fixture);
});

describe('hourly pricing honours the unpriceable cooldown (SC-296)', () => {
  test('does not ask about a token in cooldown that has never been priced', async () => {
    const f = fixture as Fixture;
    const useCase = makeUseCase([f.suppressed, f.withPrices, f.expired, f.fresh]);

    const result = await useCase.execute('USD');

    // The claim. On the old behaviour this token was asked about every hour.
    expect(asked).not.toContain(f.suppressed);
    expect(result.tokensSuppressed).toBe(1);
  });

  test('still asks about a token in cooldown that HAS a price row', async () => {
    const f = fixture as Fixture;
    const useCase = makeUseCase([f.suppressed, f.withPrices, f.expired, f.fresh]);

    await useCase.execute('USD');

    // The half a flag-only filter would get wrong: a stale mark from before
    // SC-232 sits on a token we can price perfectly well.
    expect(asked).toContain(f.withPrices);
  });

  test('asks about an expired cooldown and about a token never marked', async () => {
    const f = fixture as Fixture;
    const useCase = makeUseCase([f.suppressed, f.withPrices, f.expired, f.fresh]);

    await useCase.execute('USD');

    // `fresh` is what a holding added minutes ago looks like: no mark, so
    // nothing here can suppress it.
    expect(asked).toContain(f.fresh);
    expect(asked).toContain(f.expired);
    expect(asked.length).toBe(3);
  });

  test('a suppressed token is not counted as a failure', async () => {
    const f = fixture as Fixture;
    const useCase = makeUseCase([f.suppressed, f.withPrices, f.expired, f.fresh]);

    const result = await useCase.execute('USD');

    // The reported defect: "13 failed" when the truth was "13 suppressed on
    // purpose". Those are different sentences and only one is worth looking at.
    expect(result.tokensFailed).toBe(0);
    expect(result.tokensSuppressed).toBe(1);
    expect(result.tokensUpdated).toBe(3);
    expect(result.tokensFound).toBe(4);
  });

  test('a run where every token is suppressed reports nothing failed', async () => {
    const f = fixture as Fixture;
    const useCase = makeUseCase([f.suppressed]);

    const result = await useCase.execute('USD');

    // Before the split this path returned `tokensFailed = tokensFound` and
    // warned — the fix would have become a louder version of the bug.
    expect(result.tokensFound).toBe(1);
    expect(result.tokensSuppressed).toBe(1);
    expect(result.tokensFailed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});
