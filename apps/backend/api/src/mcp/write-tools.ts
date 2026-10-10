import {
  answerBalanceGapSchema,
  BALANCE_GAP_ANSWERS,
  MANUAL_OUTFLOW_DESTINATIONS,
  RecordHoldingMovementDto,
  TRANSFER_REVIEW_DECISIONS,
  transferDestinationRefSchema,
  transferReviewDecisionSchema,
} from '@scani/shared';
import { z } from 'zod';
import type { McpTool } from './tools';

/**
 * The tools that change data (SC-1617), listed only to a token holding the
 * write scope. Each calls existing mutations, named in `writes`, and the
 * server records the rows it changed so `undo_agent_change` can put them back.
 */

const uuid = z.string().uuid();
const UUID = { type: 'string', format: 'uuid' } as const;
const DECIMAL = { type: 'string', pattern: '^\\d+(\\.\\d+)?$' } as const;
const DESTINATION_REF = {
  type: 'object',
  properties: {
    accountId: UUID,
    holdingId: { ...UUID, description: 'null = create a holding in that account' },
  },
  required: ['accountId', 'holdingId'],
};
const LIST_CAP = 50;

const UNDO_NOTE =
  ' Returns `agentChangeId`; `undo_agent_change` with it puts back every row exactly.';

export const MCP_WRITE_TOOLS: McpTool[] = [
  {
    name: 'record_movement',
    title: 'Record a movement',
    description: `Records money moving in or out of a holding, or between two of the user's accounts. inflow and outflow change one holding; outflow needs \`destination\` (where it went). transfer writes both legs and needs \`destinationAccountId\`; \`destinationHoldingId\` is optional (omitted = find or create one), \`feeQuantity\` is carved out of \`amount\`.${UNDO_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['inflow', 'outflow', 'transfer'] },
        holdingId: UUID,
        amount: { ...DECIMAL, description: 'Positive; the direction carries the sign' },
        occurredAt: { type: 'string', description: 'ISO date-time with offset' },
        note: { type: 'string', maxLength: 500 },
        destination: {
          type: 'string',
          enum: MANUAL_OUTFLOW_DESTINATIONS.filter((d) => d !== 'internal'),
          description: 'outflow only',
        },
        destinationAccountId: { ...UUID, description: 'transfer only' },
        destinationHoldingId: { ...UUID, description: 'transfer only' },
        feeQuantity: { ...DECIMAL, description: 'transfer only' },
      },
      required: ['direction', 'holdingId', 'amount', 'occurredAt'],
    },
    input: RecordHoldingMovementDto as unknown as z.ZodType<Record<string, unknown>>,
    writes: ['holdings.recordMovement'],
    run: (caller, input) =>
      caller.holdings.recordMovement({ movement: RecordHoldingMovementDto.parse(input) }),
  },
  {
    name: 'create_holdings',
    title: 'Create holdings',
    description: `Creates up to 20 hand-entered holdings in one of the user's existing accounts (\`list_accounts\`), each a token (\`search_tokens\`) and a balance. One holding per token per account.${UNDO_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        accountId: UUID,
        holdings: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            properties: { tokenId: UUID, balance: { type: 'string' }, label: { type: 'string' } },
            required: ['tokenId', 'balance'],
          },
        },
      },
      required: ['accountId', 'holdings'],
    },
    input: z.object({
      accountId: uuid,
      holdings: z
        .array(
          z.object({
            tokenId: uuid,
            balance: z.string().min(1),
            label: z.string().max(80).optional(),
          })
        )
        .min(1)
        .max(20),
    }),
    writes: ['batchOperations.createHoldingsNow'],
    run: (caller, input) => {
      const { accountId, holdings } = input as {
        accountId: string;
        holdings: { tokenId: string; balance: string; label?: string }[];
      };
      return caller.batchOperations.createHoldingsNow({ accountId, newHoldings: holdings });
    },
  },
  {
    name: 'answer_transfer_review',
    title: 'Answer a transfer question',
    description: `Answers one outgoing transfer from \`list_review_questions\`: paired (with \`matchTransactionId\`, the deposit it became), internal (moved to another holding of the user's; needs \`destination\`), left_control, untracked or fee.${UNDO_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        transactionId: UUID,
        decision: { type: 'string', enum: [...TRANSFER_REVIEW_DECISIONS] },
        matchTransactionId: UUID,
        alsoMatchTransactionIds: { type: 'array', items: UUID },
        destination: DESTINATION_REF,
      },
      required: ['transactionId', 'decision'],
    },
    input: z.object({
      transactionId: uuid,
      decision: transferReviewDecisionSchema,
      matchTransactionId: uuid.optional(),
      alsoMatchTransactionIds: z.array(uuid).optional(),
      destination: transferDestinationRefSchema.optional(),
    }),
    writes: ['transferReview.resolve'],
    run: (caller, input) =>
      caller.transferReview.resolve(input as Parameters<typeof caller.transferReview.resolve>[0]),
  },
  {
    name: 'answer_balance_gap',
    title: 'Answer a balance question',
    description: `Says what an unexplained balance change from \`list_review_questions\` was: flow (money in or out), correction, growth (interest, yield) or unknown. A flow out may carry \`editOutflow\` (where it went).${UNDO_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        observationId: UUID,
        answer: { type: 'string', enum: [...BALANCE_GAP_ANSWERS] },
        editOutflow: {
          type: 'object',
          properties: {
            decision: { type: 'string', enum: [...MANUAL_OUTFLOW_DESTINATIONS] },
            destination: DESTINATION_REF,
            feeQuantity: DECIMAL,
          },
          required: ['decision'],
        },
        receivedQuantity: DECIMAL,
        occurredAt: { type: 'string', description: 'ISO date-time' },
      },
      required: ['observationId', 'answer'],
    },
    input: answerBalanceGapSchema as unknown as z.ZodType<Record<string, unknown>>,
    writes: ['balanceGaps.answer'],
    run: (caller, input) => caller.balanceGaps.answer(answerBalanceGapSchema.parse(input)),
  },
  {
    name: 'undo_agent_change',
    title: 'Undo an agent change',
    description:
      "Puts back every row one agent change touched, exactly as it was. Refused, changing nothing, when any of those rows was changed again since. Ids come from a write tool's `agentChangeId` or from `list_agent_changes`.",
    inputSchema: {
      type: 'object',
      properties: { agentChangeId: UUID },
      required: ['agentChangeId'],
    },
    input: z.object({ agentChangeId: uuid }),
    writes: ['agentTokens.undoWrite'],
    unjournaled: true,
    run: (caller, input) => caller.agentTokens.undoWrite({ id: input.agentChangeId as string }),
  },
];

/** Reads that only make sense beside the write tools; listed to every token. */
export const MCP_WRITE_SUPPORT_TOOLS: McpTool[] = [
  {
    name: 'search_tokens',
    title: 'Search tokens',
    description:
      'Finds a token (currency, stock, crypto) by symbol or name, for `create_holdings`.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 20 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['query'],
    },
    input: z
      .object({
        query: z.string().min(1).max(20),
        limit: z.number().int().min(1).max(50).optional(),
      })
      .strict(),
    run: async (caller, input) => ({
      // `metadata` is the provider's own payload on an external row.
      tokens: (
        await caller.tokens.search({
          query: input.query as string,
          limit: (input.limit as number | undefined) ?? 10,
        })
      ).map(({ metadata: _metadata, ...token }) => token),
    }),
  },
  {
    name: 'list_review_questions',
    title: 'List review questions',
    description: `The open questions Scani has about the user's data: outgoing transfers nobody has said the destination of, and balance changes no transaction explains. Up to ${LIST_CAP} of each.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    input: z.object({}).strict(),
    run: async (caller) => {
      const [transfers, gaps] = await Promise.all([
        caller.transferReview.listPending(),
        caller.balanceGaps.listPending(),
      ]);
      const transferList = Array.isArray(transfers) ? transfers : [];
      return {
        transfers: transferList.slice(0, LIST_CAP),
        transferCount: transferList.length,
        balanceGaps: gaps.items.slice(0, LIST_CAP),
        balanceGapCount: gaps.items.length,
      };
    },
  },
  {
    name: 'list_agent_changes',
    title: 'List agent changes',
    description:
      'Every change an agent made to this account, newest first: the tool, its input, how many rows it touched, and whether it was undone.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    input: z.object({}).strict(),
    run: async (caller) => ({ changes: await caller.agentTokens.activity() }),
  },
];
