import {
  ANSWER_ATTRIBUTIONS,
  AssetAllocationDimensionDto,
  AssetAllocationItemDto,
  BALANCE_GAP_ANSWERS,
  disposalLotMatchSchema,
  TRANSFER_CANDIDATE_REASONS,
  transferReviewRuleVerdictSchema,
} from '@scani/shared';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * What each routed agent tool answers (SC-1648), after `compact`: a null or
 * undefined field is absent, so it is optional here and never nullable, and a
 * Date is an ISO string. Every object is strict, so a field a procedure starts
 * returning fails the contract test until it is declared.
 */

const decimal = z.string();
const int = z.number().int();

const allocation = z
  .object({
    items: z.array(AssetAllocationItemDto.strict()),
    totalDebt: decimal,
    liabilityDebt: decimal,
    totalValue: decimal,
    baseCurrency: z.string(),
  })
  .strict();

const disposal = disposalLotMatchSchema.shape;

const journaled = <T extends z.ZodTypeAny>(result: T) =>
  z
    .object({
      agentChangeId: z.string().uuid(),
      rowsChanged: int,
      result,
      replayed: z.literal(true).optional(),
    })
    .strict();

const transferCandidate = z
  .object({
    transactionId: z.string(),
    holdingId: z.string(),
    accountName: z.string(),
    institutionName: z.string().optional(),
    tokenSymbol: z.string(),
    kind: z.string(),
    quantity: decimal,
    occurredAt: z.string(),
    reason: z.enum(TRANSFER_CANDIDATE_REASONS),
    quantityDeltaPct: z.number(),
    timeDeltaMs: int,
    withinStrictTolerance: z.boolean(),
  })
  .strict();

const transferCombination = z
  .object({
    holdingId: z.string(),
    accountName: z.string(),
    institutionName: z.string().optional(),
    tokenSymbol: z.string(),
    quantity: decimal,
    quantityDeltaPct: z.number(),
    parts: z.array(
      z.object({ transactionId: z.string(), quantity: decimal, occurredAt: z.string() }).strict()
    ),
  })
  .strict();

const pendingTransfer = z
  .object({
    transactionId: z.string(),
    holdingId: z.string(),
    tokenSymbol: z.string(),
    tokenName: z.string().optional(),
    accountName: z.string(),
    institutionName: z.string().optional(),
    kind: z.string(),
    quantity: decimal,
    occurredAt: z.string(),
    counterparty: z.string().optional(),
    counterpartyKey: z.string().optional(),
    description: z.string().optional(),
    marketValueInBase: decimal.optional(),
    baseCurrencyCode: z.string(),
    explorerTxUrl: z.string().optional(),
    explorerAddressUrl: z.string().optional(),
    counterpartyIsOwnWallet: z.boolean(),
    matchedRule: z
      .object({
        ruleId: z.string(),
        note: z.string(),
        verdict: transferReviewRuleVerdictSchema,
      })
      .strict()
      .optional(),
    answerWithdrawnBy: z.enum(ANSWER_ATTRIBUTIONS).optional(),
    candidates: z.array(transferCandidate),
    combinations: z.array(transferCombination),
  })
  .strict();

const balanceGap = z
  .object({
    observationId: z.string(),
    holdingId: z.string(),
    tokenSymbol: z.string(),
    tokenTypeCode: z.string(),
    accountName: z.string().optional(),
    from: z.string(),
    to: z.string(),
    previousBalance: decimal,
    balance: decimal,
    drift: decimal,
    baseValue: decimal,
    baseCurrency: z.string(),
    transactionsApplied: int,
    datePrompted: z.boolean(),
  })
  .strict();

const returnsScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z
    .object({
      kind: z.enum(['holding', 'account', 'institution', 'group', 'vault']),
      id: z.string(),
    })
    .strict(),
]);

const xirr = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      rate: z.number(),
      method: z.enum(['bisection', 'bisection+newton']),
      iterations: int,
      uniqueRoot: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal('undefined'),
      reason: z.enum(['too-few-flows', 'no-sign-change', 'zero-span', 'ineligible']),
    })
    .strict(),
  z.object({ status: z.literal('not-converged'), reason: z.literal('no-root-in-domain') }).strict(),
]);

const returns = z
  .object({
    scope: returnsScope,
    baseCurrencyId: z.string(),
    requestedWindow: z.object({ kind: z.string(), from: z.string(), to: z.string() }).strict(),
    effectiveWindow: z.object({ from: z.string(), to: z.string() }).strict().optional(),
    startValue: decimal.optional(),
    endValue: decimal.optional(),
    netExternalFlow: decimal,
    twr: z
      .object({
        cumulative: decimal,
        annualized: decimal.optional(),
        measuredPeriods: int,
        skippedPeriods: int,
        spanDays: int,
      })
      .strict()
      .optional(),
    attribution: z
      .object({
        assetReturn: decimal,
        currencyReturn: decimal,
        baseReturn: decimal,
        crossTerm: decimal,
        attributedPeriods: int,
        unattributedPeriods: int,
        unpricedCurrencyPeriods: int,
        currencies: z.array(
          z.object({ currencyTokenId: z.string().optional(), endWeight: decimal }).strict()
        ),
      })
      .strict()
      .optional(),
    xirr,
    coverage: z
      .object({
        measuredDays: int,
        windowDays: int,
        daysNotFullyCovered: int,
        skippedPeriods: int,
        unvaluedFlows: int,
        staleValuedFlows: int,
        flowsAfterLastMeasuredDay: int,
      })
      .strict(),
    eligibility: z.object({ eligible: z.boolean(), reasons: z.array(z.string()) }).strict(),
    subset: z
      .object({
        includedHoldings: int,
        measuredHoldings: int,
        excluded: z.array(z.object({ reason: z.string(), holdings: int }).strict()),
        excludedValue: decimal,
        enteredLate: int,
        unpricedAtZero: int,
      })
      .strict()
      .optional(),
  })
  .strict();

export const TOOL_OUTPUTS: Readonly<Record<string, z.ZodTypeAny>> = {
  get_portfolio_summary: z
    .object({
      portfolioValue: z.object({ totalValue: decimal, baseCurrency: z.string() }).strict(),
      counts: z.object({ institutions: int, accounts: int, holdings: int }).strict(),
      topHoldings: z.array(
        z
          .object({
            symbol: z.string(),
            name: z.string(),
            balance: decimal,
            value: decimal,
            currentPrice: decimal,
            tokenType: z.string(),
            tokenTypeCode: z.string(),
            accountId: z.string(),
            accountName: z.string(),
            accountTypeCode: z.string(),
            institutionId: z.string(),
            institutionName: z.string(),
            institutionWebsite: z.string().optional(),
          })
          .strict()
      ),
      assetAllocation: allocation,
    })
    .strict(),

  get_allocation: allocation.extend({ dimension: AssetAllocationDimensionDto }),

  list_holdings: z
    .object({
      summary: z.object({ totalCount: int, activeCount: int, totalValue: decimal }).strict(),
      holdings: z.array(
        z
          .object({
            id: z.string(),
            label: z.string().optional(),
            symbol: z.string(),
            name: z.string(),
            tokenId: z.string(),
            assetType: z.string(),
            amount: decimal,
            value: decimal.optional(),
            costBasis: decimal.optional(),
            price: decimal.optional(),
            priceAt: z.string().optional(),
            account: z.object({ id: z.string(), name: z.string() }).strict(),
            institution: z.string(),
            groups: z.array(z.string()),
            possibleScam: z.literal(true).optional(),
            lastUpdated: z.string(),
          })
          .strict()
      ),
    })
    .strict(),

  list_accounts: z
    .object({
      accounts: z.array(
        z
          .object({
            id: z.string(),
            institutionId: z.string(),
            name: z.string(),
            typeId: z.string(),
            type: z.string(),
            typeName: z.string(),
            description: z.string().optional(),
            entityId: z.string().optional(),
            isHidden: z.boolean(),
            isActive: z.boolean(),
            createdAt: z.string(),
            updatedAt: z.string(),
            summary: z
              .object({ holdingsCount: int, totalValue: decimal, totalDebt: decimal })
              .strict(),
            groups: z.array(
              z.object({ id: z.string(), name: z.string(), color: z.string().optional() }).strict()
            ),
          })
          .strict()
      ),
    })
    .strict(),

  list_transactions: z
    .object({
      transactions: z.array(
        z
          .object({
            id: z.string(),
            occurredAt: z.string(),
            kind: z.string(),
            ledgerKind: z.string().optional(),
            quantity: decimal,
            feeQuantity: decimal.optional(),
            feeTokenId: z.string().optional(),
            holdingId: z.string(),
            tokenId: z.string(),
            counterparty: z.string().optional(),
            description: z.string().optional(),
            source: z.string(),
          })
          .strict()
      ),
      nextOffset: int.optional(),
    })
    .strict(),

  get_returns: z
    .object({
      returns: returns.optional(),
      gains_by_treatment: z.discriminatedUnion('status', [
        z.object({ status: z.literal('rebuilding'), anyWrapped: z.boolean() }).strict(),
        z
          .object({
            status: z.literal('ok'),
            buckets: z.array(
              z
                .object({
                  treatment: z.enum(['general', 'deferred', 'exempt', 'advantaged']),
                  realized: decimal,
                  unrealized: decimal,
                  accountCount: z.number().int(),
                })
                .strict()
            ),
            anyWrapped: z.boolean(),
            carriedHoldings: z.number().int(),
          })
          .strict(),
      ]),
      benchmarks: z.array(
        z
          .object({
            key: z.enum(['btc', 'sp500', 'us_inflation']),
            cumulative: decimal.optional(),
          })
          .strict()
      ),
    })
    .strict(),

  get_net_worth_series: z
    .object({
      series: z.array(
        z
          .object({
            date: z.string(),
            totalValue: decimal,
            coverageQuality: z.string(),
            holdingsWithKnownValue: int,
            holdingsTotal: int,
            holdingsUnpriceable: int,
            holdingsStalePriced: int,
            holdingsStaleAnchored: int.optional(),
            oldestAnchorAt: z.string().optional(),
            holdingsBeforeRecords: int.optional(),
            holdingsBasisUnknown: int,
          })
          .strict()
      ),
      baseCurrencyId: z.string().optional(),
      granularity: z.enum(['daily', 'weekly', 'monthly']),
      unmeasuredDates: z.array(z.string()),
    })
    .strict(),

  get_realized_gains: z
    .object({
      holdingId: z.string(),
      baseCurrencyId: z.string().optional(),
      rows: z.array(
        z
          .object({
            transactionId: z.string(),
            holdingId: z.string(),
            tokenId: z.string(),
            kind: z.string(),
            disposedAt: z.string(),
            acquiredAt: z.string().optional(),
            quantity: decimal,
            proceeds: decimal.optional(),
            costBasis: decimal,
            gain: decimal.optional(),
            holdingDays: int.optional(),
            portionIndex: int,
            portionCount: int,
            basisQuality: disposal.basisQuality,
            outcome: disposal.outcome,
            valuationBasis: disposal.valuationBasis.unwrap().optional(),
            answerSource: disposal.answerSource,
          })
          .strict()
      ),
      realizedTotal: decimal,
    })
    .strict(),

  get_data_quality: z
    .object({
      flagged: z
        .object({
          duplicateSymbol: z.array(z.string()),
          lookalike: z.array(z.string()),
          zeroBalance: z.array(z.string()),
          noRecentPrice: z.array(z.string()),
          noPriceSource: z.array(z.string()),
          negativeOpening: z.array(z.string()),
          noCoverage: z.array(z.string()),
          restoredUnmatched: z.array(z.string()),
        })
        .strict(),
      hiddenWithNewBalance: z.array(z.string()),
      duplicateTokens: z.array(
        z.object({ symbol: z.string(), count: int, lookalikeOf: z.string().optional() }).strict()
      ),
      lookalikeTokens: z.array(z.object({ symbol: z.string(), lookalikeOf: z.string() }).strict()),
      unroutableTokens: z.array(
        z.object({ symbol: z.string(), segment: z.string().optional() }).strict()
      ),
      holdings: z
        .object({
          total: int,
          visible: int,
          zeroVisible: int,
          zeroVisibleStale: int,
          unpricedVisible: int,
          unpriceableVisible: int,
          negativeOpening: int,
          missingCoverage: int,
          restoredUnmatched: int,
        })
        .strict(),
      thresholds: z.object({ staleClosedDays: int }).strict(),
    })
    .strict(),

  get_open_lots: z
    .object({
      holdings: z.array(
        z
          .object({
            holdingId: z.string(),
            symbol: z.string().optional(),
            basisQuality: disposal.basisQuality,
            openQuantity: decimal,
            costBasis: decimal,
            price: decimal.optional(),
            lots: z.array(
              z
                .object({
                  acquiredAt: z.string(),
                  daysHeld: int,
                  quantity: decimal,
                  cost: decimal,
                  unrealisedGain: decimal.optional(),
                  stale: z.literal(true).optional(),
                  unpriced: z.literal(true).optional(),
                })
                .strict()
            ),
          })
          .strict()
      ),
    })
    .strict(),

  search_tokens: z
    .object({
      tokens: z.array(
        z
          .object({
            id: z.string().optional(),
            symbol: z.string(),
            name: z.string(),
            typeId: z.string().optional(),
            type: z.string().optional(),
            typeName: z.string().optional(),
            decimals: int.optional(),
            isActive: z.boolean().optional(),
            source: z.enum(['database', 'external']),
            provider: z.enum(['finnhub', 'coingecko', 'defillama']).optional(),
          })
          .strict()
      ),
    })
    .strict(),

  list_review_questions: z
    .object({
      transfers: z.array(pendingTransfer),
      transferCount: int,
      balanceGaps: z.array(balanceGap),
      balanceGapCount: int,
    })
    .strict(),

  list_agent_changes: z
    .object({
      changes: z.array(
        z
          .object({
            id: z.string(),
            actor: z.string(),
            tool: z.string(),
            input: z.unknown(),
            status: z.enum(['applied', 'failed', 'undone']),
            changeCount: int,
            createdAt: z.string(),
            undoneAt: z.string().optional(),
            undoneBy: z.string().optional(),
          })
          .strict()
      ),
    })
    .strict(),

  record_movement: journaled(
    z
      .object({
        holdingId: z.string(),
        balance: decimal,
        destinationHoldingId: z.string().optional(),
        destinationBalance: decimal.optional(),
        transferGroupId: z.string().optional(),
      })
      .strict()
  ),

  create_holdings: journaled(
    z
      .object({
        accountId: z.string(),
        holdings: z.array(
          z
            .object({
              id: z.string(),
              tokenId: z.string(),
              balance: decimal,
              priced: z.boolean(),
            })
            .strict()
        ),
      })
      .strict()
  ),

  answer_transfer_review: journaled(z.object({ ok: z.boolean() }).strict()),

  answer_balance_gap: journaled(
    z
      .object({
        observationId: z.string(),
        answer: z.enum(BALANCE_GAP_ANSWERS),
        wroteKind: z.enum(['deposit', 'withdraw', 'correction']).optional(),
        occurredAt: z.string().optional(),
      })
      .strict()
  ),

  undo_agent_change: z.object({ undone: z.boolean(), restoredRows: int }).strict(),
};

function open(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(open);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(node)) {
    if (key === 'additionalProperties' && inner === false) continue;
    out[key] = open(inner);
  }
  return out;
}

const published = new Map<string, Record<string, unknown>>();

/**
 * A tool's answer as JSON Schema, for the OpenAPI document and MCP's
 * `outputSchema`. The zod schemas are strict so a test catches an undeclared
 * field; the published one is not, because an answer may gain fields.
 */
export function outputJsonSchema(tool: string): Record<string, unknown> | undefined {
  const schema = TOOL_OUTPUTS[tool];
  if (!schema) return undefined;
  const cached = published.get(tool);
  if (cached) return cached;
  const { $schema: _dialect, ...json } = zodToJsonSchema(schema, {
    $refStrategy: 'none',
    target: 'jsonSchema7',
  }) as Record<string, unknown>;
  const result = open(json) as Record<string, unknown>;
  published.set(tool, result);
  return result;
}
