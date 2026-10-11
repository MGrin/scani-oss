/**
 * SC-1648. The answer each route gives is what its tool's `output` schema
 * says, checked against a seeded, priced account. Every object in those
 * schemas is strict, so a field a procedure starts returning fails here until
 * someone declares it: the published contract cannot drift from the code.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { ALL_TOOLS } from '../../src/agent-access/pipeline';
import { outputJsonSchema, TOOL_OUTPUTS } from '../../src/mcp/outputs';
import { createMcpDeps, handleMcpRequest } from '../../src/mcp/server';
import { REST_ROUTES } from '../../src/rest/routes';
import {
  baseCurrencyId,
  removeTenants,
  seedBaseCurrency,
  seedTenant,
  type Tenant,
  tokenIds,
} from '../helpers/agent-tenant';
import { roomyHeavyLimiter } from '../helpers/limiters';
import { rest } from '../helpers/rest-client';

let alice: Tenant;
const answers: Record<string, unknown> = {};

async function read(path: string) {
  const res = await rest(alice.writeToken, 'GET', path);
  expect({ path, status: res.status, body: res.status === 200 ? null : res.body }).toEqual({
    path,
    status: 200,
    body: null,
  });
  return res.body;
}

async function write(path: string, body: unknown) {
  const res = await rest(alice.writeToken, 'POST', path, { body });
  expect({ path, status: res.status, body: res.status === 200 ? null : res.body }).toEqual({
    path,
    status: 200,
    body: null,
  });
  return res.body;
}

beforeAll(async () => {
  await seedBaseCurrency();
  alice = await seedTenant('alice');

  // Priced, so values, allocation, top holdings and a balance gap above the
  // review threshold all exist.
  const held = await db
    .select({ tokenId: schema.holdings.tokenId })
    .from(schema.holdings)
    .where(eq(schema.holdings.userId, alice.userId));
  // Two readings each: a balance gap is priced at the time it happened.
  await db.insert(schema.tokenPrices).values(
    [...new Set(held.map((h) => h.tokenId))].flatMap((tokenId) =>
      [new Date('2025-12-01T00:00:00Z'), new Date()].map((timestamp) => ({
        tokenId,
        baseTokenId: baseCurrencyId,
        price: '2',
        timestamp,
        source: 'test-fixture',
      }))
    )
  );

  const movement = (direction: string, amount: string, at: string, extra = {}) => ({
    direction,
    holdingId: alice.holdingId,
    amount,
    occurredAt: at,
    ...extra,
  });
  answers.record_movement = await write(
    '/movements',
    movement('inflow', '5', '2026-10-01T09:00:00Z')
  );
  await write(
    '/movements',
    movement('outflow', '2', '2026-10-02T09:00:00Z', { destination: 'left_control' })
  );
  answers.record_movement_transfer = await write(
    '/movements',
    movement('transfer', '10', '2026-10-03T09:00:00Z', {
      feeQuantity: '1',
      destinationAccountId: alice.otherAccountId,
    })
  );
  answers.create_holdings = await write('/holdings', {
    accountId: alice.otherAccountId,
    holdings: [{ tokenId: baseCurrencyId, balance: '250' }],
  });

  answers.get_portfolio_summary = await read('/portfolio/summary');
  answers.get_allocation = await read('/portfolio/allocation?dimension=account');
  answers.get_returns = await read('/portfolio/returns?window=all');
  // The user-wide series sums per-holding rollup rows. Two days, one per shape
  // a day can take: a count recorded, and one that predates its column (NULL).
  await db.insert(schema.portfolioValueDaily).values([
    {
      userId: alice.userId,
      scopeKind: 'holding',
      scopeId: alice.holdingId,
      snapshotDate: '2026-09-01',
      baseCurrencyId,
      totalValue: '2000',
      coverageQuality: 'complete',
      holdingsWithKnownValue: 2,
      holdingsTotal: 2,
      holdingsStaleAnchored: 1,
      oldestAnchorAt: new Date('2026-08-01T00:00:00Z'),
      holdingsBeforeRecords: 0,
    },
    {
      userId: alice.userId,
      scopeKind: 'holding',
      scopeId: alice.holdingId,
      snapshotDate: '2026-09-02',
      baseCurrencyId,
      totalValue: '2100.5',
      coverageQuality: 'partial',
      holdingsWithKnownValue: 1,
      holdingsTotal: 2,
    },
  ]);
  answers.get_net_worth_series = await read(
    '/portfolio/net-worth?from=2026-09-01&to=2026-09-02&granularity=daily'
  );
  answers.get_realized_gains = await read(`/portfolio/realized-gains?holdingId=${alice.holdingId}`);
  answers.get_data_quality = await read('/portfolio/data-quality');
  answers.list_accounts = await read('/accounts');
  answers.list_holdings = await read('/holdings');
  answers.get_open_lots = await read('/lots');
  answers.list_transactions = await read('/transactions');
  answers.search_tokens = await read('/tokens?query=WALICE');
  answers.list_review_questions = await read('/review-questions');

  answers.answer_transfer_review = await write(
    `/review-questions/transfers/${alice.outflowId}/answer`,
    { decision: 'left_control' }
  );
  const gap = (await write(`/review-questions/balance-gaps/${alice.gapObservationId}/answer`, {
    answer: 'flow',
    editOutflow: {
      decision: 'internal',
      destination: { accountId: alice.otherAccountId, holdingId: alice.gapDestinationHoldingId },
      feeQuantity: '5',
    },
  })) as { agentChangeId: string };
  answers.answer_balance_gap = gap;
  answers.list_agent_changes = await read('/changes');
  answers.undo_agent_change = await write(`/changes/${gap.agentChangeId}/undo`, {});
});

afterAll(async () => {
  await db.delete(schema.tokenPrices).where(inArray(schema.tokenPrices.tokenId, tokenIds));
  await db
    .delete(schema.portfolioValueDaily)
    .where(eq(schema.portfolioValueDaily.userId, alice.userId));
  await removeTenants();
});

const ROUTED = REST_ROUTES.map((r) => r.tool);

/** A money or quantity figure by its key; a count that merely ends the same way is exempt. */
const MONEY_KEY =
  /^(amount|balance|quantity|value|cost|costBasis|price|proceeds|gain|fee|realizedTotal)$|(Amount|Balance|Quantity|Value|Cost|Price|Proceeds|Gain|Debt|Flow)$/;
const COUNTS = new Set(['holdingsWithKnownValue']);

function numbersUnderMoneyKeys(value: unknown, path = ''): string[] {
  if (Array.isArray(value))
    return value.flatMap((v, i) => numbersUnderMoneyKeys(v, `${path}[${i}]`));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, inner]) => {
    const here = `${path}.${key}`;
    if (typeof inner === 'number') return MONEY_KEY.test(key) && !COUNTS.has(key) ? [here] : [];
    return numbersUnderMoneyKeys(inner, here);
  });
}

describe('the answer each route gives is the one its tool declares (SC-1648)', () => {
  test('every routed tool declares its answer, and no other tool does', () => {
    expect(Object.keys(TOOL_OUTPUTS).sort()).toEqual([...ROUTED].sort());
    for (const name of ROUTED) {
      expect({ name, declared: Boolean(ALL_TOOLS.find((t) => t.name === name)?.output) }).toEqual({
        name,
        declared: true,
      });
    }
  });

  for (const name of ROUTED) {
    test(`${name} answers what its schema says`, () => {
      expect(answers[name]).toBeDefined();
      const parsed = TOOL_OUTPUTS[name]?.safeParse(answers[name]);
      expect(parsed?.success ? [] : parsed?.error.issues).toEqual([]);
    });
  }

  test("/mcp publishes the same schema as each tool's outputSchema, and none for the rest", async () => {
    const res = await handleMcpRequest(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${alice.writeToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      createMcpDeps({
        accessAllowed: async () => true,
        heavyLimiter: roomyHeavyLimiter(),
        limiter: roomyHeavyLimiter(),
      })
    );
    const { result } = (await res.json()) as {
      result: { tools: { name: string; outputSchema?: { type: string } }[] };
    };
    expect(result.tools.length).toBe(ALL_TOOLS.length);
    for (const tool of result.tools) {
      expect({ name: tool.name, schema: tool.outputSchema }).toEqual({
        name: tool.name,
        schema: outputJsonSchema(tool.name) as { type: string } | undefined,
      });
      expect({ name: tool.name, typed: tool.outputSchema?.type === 'object' }).toEqual({
        name: tool.name,
        typed: ROUTED.includes(tool.name),
      });
    }
  });

  test('a transfer answers the movement schema too', () => {
    const parsed = TOOL_OUTPUTS.record_movement?.safeParse(answers.record_movement_transfer);
    expect(parsed?.success ? [] : parsed?.error.issues).toEqual([]);
  });

  test('the control bites: an undeclared field is refused', () => {
    const tampered = { ...(answers.list_accounts as object), surprise: 1 };
    expect(TOOL_OUTPUTS.list_accounts?.safeParse(tampered).success).toBe(false);
  });

  test('the seeded account fills the lists, so the item schemas were exercised', () => {
    // biome-ignore lint/suspicious/noExplicitAny: reading the fixture's own answers by path
    const a = answers as Record<string, any>;
    const filled = {
      topHoldings: a.get_portfolio_summary.topHoldings.length,
      allocation: a.get_allocation.items.length,
      realizedRows: a.get_realized_gains.rows.length,
      accounts: a.list_accounts.accounts.length,
      holdings: a.list_holdings.holdings.length,
      pricedHoldings: a.list_holdings.holdings.filter((h: { value?: string }) => h.value).length,
      lots: a.get_open_lots.holdings.flatMap((h: { lots: unknown[] }) => h.lots).length,
      transactions: a.list_transactions.transactions.length,
      tokens: a.search_tokens.tokens.length,
      reviewTransfers: a.list_review_questions.transfers.length,
      balanceGaps: a.list_review_questions.balanceGaps.length,
      changes: a.list_agent_changes.changes.length,
      netWorthDays: a.get_net_worth_series.series.length,
      anchoredDays: a.get_net_worth_series.series.filter(
        (d: { oldestAnchorAt?: string }) => d.oldestAnchorAt
      ).length,
      unrecordedDays: a.get_net_worth_series.series.filter(
        (d: { holdingsStaleAnchored?: number }) => d.holdingsStaleAnchored === undefined
      ).length,
    };
    expect(Object.entries(filled).filter(([, n]) => n === 0)).toEqual([]);
  });

  test("each of returns' rate outcomes is a variant the schema takes", () => {
    const outcomes = [
      { status: 'ok', rate: 0.05, method: 'bisection', iterations: 12, uniqueRoot: true },
      { status: 'undefined', reason: 'too-few-flows' },
      { status: 'not-converged', reason: 'no-root-in-domain' },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: swapping one field of the fixture's own answer
    const real = answers.get_returns as any;
    expect(real.returns).toBeDefined();
    const field = 'xirr';
    expect(field).toBeDefined();
    for (const outcome of outcomes) {
      const variant = { ...real, returns: { ...real.returns, [field as string]: outcome } };
      const parsed = TOOL_OUTPUTS.get_returns?.safeParse(variant);
      expect({
        outcome: outcome.status,
        issues: parsed?.success ? [] : parsed?.error.issues,
      }).toEqual({
        outcome: outcome.status,
        issues: [],
      });
    }
    // The empty portfolio answers no returns at all, and four empty buckets.
    const noGains = ['general', 'deferred', 'exempt', 'advantaged'].map((treatment) => ({
      treatment,
      realized: '0',
      unrealized: '0',
      accountCount: 0,
    }));
    expect(
      TOOL_OUTPUTS.get_returns?.safeParse({
        benchmarks: [],
        gains_by_treatment: {
          status: 'ok',
          buckets: noGains,
          anyWrapped: false,
          carriedHoldings: 0,
        },
      }).success
    ).toBe(true);
  });

  test('no money or quantity figure is a JSON number', () => {
    expect(Object.entries(answers).flatMap(([name, a]) => numbersUnderMoneyKeys(a, name))).toEqual(
      []
    );
  });
});
