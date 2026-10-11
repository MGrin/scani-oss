/**
 * SC-1614's falsifier: user A's token returns nothing of user B's, on EVERY
 * tool. The tool list is read from `MCP_TOOLS`, so a new tool with no row in
 * `ARGS` below fails here rather than shipping unchecked.
 *
 * Each user owns an account, a holding of a token only they hold, and a
 * transaction, all carrying a marker string. A tool's output for one user must
 * never contain the other's markers. The control runs the other way: the
 * listing tools must contain the CALLER's markers, so an empty answer cannot
 * pass as a safe one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { HouseholdAccessService } from '@scani/domain/services';
import {
  makeAccount,
  makeHolding,
  makeInstitution,
  makeInstitutionType,
  makeToken,
} from '@scani/domain/test-helpers';
import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';
import { inArray } from 'drizzle-orm';
import { PersonalAccessTokenService } from '../../src/auth/personal-access-tokens';
import { createMcpDeps, handleMcpRequest } from '../../src/mcp/server';
import { MCP_TOOLS } from '../../src/mcp/tools';
import { MCP_WRITE_SUPPORT_TOOLS } from '../../src/mcp/write-tools';
import { setSessionRevokeLimiterForContext } from '../../src/presentation/trpc';
import { roomyHeavyLimiter } from '../helpers/limiters';

const suffix = randomUUID().slice(0, 8);
const seedDb = db as unknown as DatabaseTransaction;

interface Tenant {
  userId: string;
  token: string;
  accountId: string;
  holdingId: string;
  transactionId: string;
  markers: string[];
}

const users: string[] = [];
const tokenIds: string[] = [];
const institutionIds: string[] = [];
const householdIds: string[] = [];

let baseCurrencyId: string;

async function seedTenant(name: string): Promise<Tenant> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1614-${name}-${suffix}@scani.local`, name, baseCurrencyId })
    .returning();
  if (!user) throw new Error(`user insert failed: ${name}`);
  users.push(user.id);

  const type = await makeInstitutionType(seedDb, { code: 'bank' });
  const institution = await makeInstitution(seedDb, {
    typeId: type.id,
    name: `${name}-bank-${suffix}`,
  });
  institutionIds.push(institution.id);
  const account = await makeAccount(seedDb, {
    userId: user.id,
    institutionId: institution.id,
    name: `${name}-account-${suffix}`,
  });
  const token = await makeToken(seedDb, { symbol: `${name.toUpperCase()}${suffix.toUpperCase()}` });
  tokenIds.push(token.id);
  const holding = await makeHolding(seedDb, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    balance: '42',
  });
  const [transaction] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: user.id,
      holdingId: holding.id,
      tokenId: token.id,
      kind: 'deposit',
      quantity: '42',
      occurredAt: new Date('2026-09-01T00:00:00Z'),
      source: 'test-fixture',
      externalId: randomUUID(),
      description: `${name}-memo-${suffix}`,
    })
    .returning();
  if (!transaction) throw new Error('transaction insert failed');

  const minted = await new PersonalAccessTokenService().create(user.id, `${name} agent`);
  return {
    userId: user.id,
    token: minted.token,
    accountId: account.id,
    holdingId: holding.id,
    transactionId: transaction.id,
    markers: [
      account.id,
      holding.id,
      transaction.id,
      `${name}-account-${suffix}`,
      `${name}-memo-${suffix}`,
      token.symbol,
    ],
  };
}

let alice: Tenant;
let bob: Tenant;

/** Arguments per tool, for the caller `self`. Every tool must have a row. */
const ARGS: Record<string, (self: Tenant) => Record<string, unknown>> = {
  get_portfolio_summary: () => ({}),
  get_allocation: () => ({ dimension: 'account' }),
  list_holdings: () => ({}),
  list_accounts: () => ({}),
  list_transactions: () => ({}),
  get_returns: () => ({ window: 'all' }),
  get_net_worth_series: () => ({ from: '2026-01-01', to: '2026-10-07' }),
  get_realized_gains: (self) => ({ holding_id: self.holdingId }),
  get_data_quality: () => ({}),
  get_portfolio_analysis: () => ({}),
  plan_rebalance: () => ({ group_by: 'asset_type', targets: [{ key: 'crypto', percent: 100 }] }),
  get_open_lots: (self) => ({ holding_ids: [self.holdingId] }),
  get_suggestions: () => ({}),
  search_tokens: () => ({ query: `ZZ${suffix}` }),
  list_review_questions: () => ({}),
  list_agent_changes: () => ({}),
};

// Every tool a read-only token is offered; the write tools' tenancy is in
// `mcp-agent-writes.test.ts`.
const READ_TOOLS = [...MCP_TOOLS, ...MCP_WRITE_SUPPORT_TOOLS];

/** Tools whose answer names the caller's own rows, and which row, so the control can bite. */
const LISTING: Record<string, (self: Tenant) => string> = {
  list_holdings: (self) => self.holdingId,
  list_accounts: (self) => self.accountId,
  list_transactions: (self) => self.transactionId,
};

const deps = () =>
  createMcpDeps({
    accessAllowed: async () => true,
    heavyLimiter: roomyHeavyLimiter(),
    limiter: new InMemoryInflowRateLimiter({
      windowMs: 60_000,
      max: 10_000,
      namespace: `rl:test-mcp-tenancy-${suffix}`,
    }),
  });

async function call(caller: Tenant, name: string, args: Record<string, unknown>) {
  const res = await handleMcpRequest(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${caller.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
    deps()
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result?: { isError?: boolean }; error?: unknown };
  expect(body.error).toBeUndefined();
  return { raw: JSON.stringify(body), isError: body.result?.isError === true };
}

beforeAll(async () => {
  setSessionRevokeLimiterForContext(
    new InMemoryInflowRateLimiter({ windowMs: 60_000, max: 1000, namespace: `rl:t-${suffix}` })
  );
  const base = await makeToken(seedDb, {
    symbol: `BASE${suffix.toUpperCase()}`,
    name: 'SC-1614 base',
  });
  tokenIds.push(base.id);
  baseCurrencyId = base.id;
  alice = await seedTenant('alice');
  bob = await seedTenant('bob');

  // SC-1647: both tenants share one household, each account shared into it.
  // Household access is view-only and never reaches an agent token, so every
  // assertion below must hold exactly as it does for two strangers.
  const [household] = await db
    .insert(schema.households)
    .values({ name: `sc1647-${suffix}`, baseCurrencyId, createdBy: alice.userId })
    .returning({ id: schema.households.id });
  if (!household) throw new Error('household insert failed');
  householdIds.push(household.id);
  await db.insert(schema.householdMembers).values([
    { householdId: household.id, userId: alice.userId, role: 'admin' },
    { householdId: household.id, userId: bob.userId, role: 'member' },
  ]);
  await db.insert(schema.accountShares).values([
    { accountId: alice.accountId, householdId: household.id, sharedBy: alice.userId },
    { accountId: bob.accountId, householdId: household.id, sharedBy: bob.userId },
  ]);
});

afterAll(async () => {
  await db.delete(schema.households).where(inArray(schema.households.id, householdIds));
  await db.delete(schema.users).where(inArray(schema.users.id, users));
  await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutionIds));
  await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokenIds.reverse()));
});

describe('MCP tenancy pair', () => {
  test('the household control: each tenant can see the other’s shared account (SC-1647)', async () => {
    const seen = await new HouseholdAccessService().visibleAccounts(bob.userId);
    expect(seen.map((v) => v.accountId).sort()).toEqual([alice.accountId, bob.accountId].sort());
  });

  test('every tool has a tenancy row', () => {
    expect(READ_TOOLS.map((t) => t.name).sort()).toEqual(Object.keys(ARGS).sort());
  });

  for (const tool of READ_TOOLS) {
    test(`${tool.name}: each token sees its own rows and none of the other's`, async () => {
      const args = ARGS[tool.name];
      if (!args) throw new Error(`no tenancy row for ${tool.name}`);
      for (const [self, other] of [
        [alice, bob],
        [bob, alice],
      ] as const) {
        const { raw, isError } = await call(self, tool.name, args(self));
        expect(isError).toBe(false);
        for (const marker of other.markers) expect(raw).not.toContain(marker);
        const own = LISTING[tool.name];
        if (own) expect(raw).toContain(own(self));
      }
    });
  }

  test("naming the other user's holding is refused, not answered", async () => {
    const { raw, isError } = await call(alice, 'get_realized_gains', { holding_id: bob.holdingId });
    expect(isError).toBe(true);
    for (const marker of bob.markers.filter((m) => m !== bob.holdingId)) {
      expect(raw).not.toContain(marker);
    }
  });

  test("asking for the other user's open lots is refused, not answered", async () => {
    const { raw, isError } = await call(alice, 'get_open_lots', { holding_ids: [bob.holdingId] });
    expect(isError).toBe(true);
    for (const marker of bob.markers) expect(raw).not.toContain(marker);
  });

  test("filtering by the other user's account returns none of its rows", async () => {
    const { raw } = await call(alice, 'list_transactions', { account_id: bob.accountId });
    expect(raw).not.toContain(bob.transactionId);
    expect(raw).not.toContain(`bob-memo-${suffix}`);
  });

  test('the listing control bites: alice sees her own transaction', async () => {
    const { raw } = await call(alice, 'list_transactions', {});
    expect(raw).toContain(alice.transactionId);
    expect(raw).toContain(`alice-memo-${suffix}`);
  });
});
