/**
 * Transactions tRPC router
 *
 * CRUD over `holding_transactions` scoped to manual user entry
 * (source='user-entered'). Every write ownership-checks by joining
 * through the account to ensure the tx belongs to the authenticated
 * user, so we can't accept spoofed userId fields.
 *
 * Ingester-sourced rows are listed but not mutated via this router;
 * they come and go via their respective ingesters and the deduplication
 * key.
 */

import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { HoldingTransactionRepository } from '@scani/domain/repositories';
import { HoldingService } from '@scani/domain/services';
import { TRPCError } from '@trpc/server';
import { and, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const ListInput = z.object({
  accountId: z.string().uuid().optional(),
  tokenId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  kinds: z.array(z.string()).optional(),
  source: z.string().optional(),
  limit: z.number().int().positive().max(500).default(100),
  offset: z.number().int().nonnegative().default(0),
});

const CreateInput = z.object({
  accountId: z.string().uuid(),
  tokenId: z.string().uuid(),
  kind: z.enum([
    'buy',
    'sell',
    'deposit',
    'withdraw',
    'transfer_in',
    'transfer_out',
    'fee',
    'reward',
    'interest',
    'airdrop',
  ]),
  quantity: z.string(),
  priceNative: z.string().optional(),
  priceNativeTokenId: z.string().uuid().optional(),
  counterTokenId: z.string().uuid().optional(),
  counterQuantity: z.string().optional(),
  feeQuantity: z.string().optional(),
  feeTokenId: z.string().uuid().optional(),
  occurredAt: z.coerce.date(),
  note: z.string().max(500).optional(),
});

const DeleteInput = z.object({ id: z.string().uuid() });

export const transactionsRouter = router({
  list: protectedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const { dbUser } = await requireAuth(ctx);
    const repo = Container.get(HoldingTransactionRepository);
    const rows = await repo.findByRange({
      userId: dbUser.id,
      accountId: input.accountId,
      tokenId: input.tokenId,
      from: input.from,
      to: input.to,
      kinds: input.kinds,
      source: input.source,
      limit: input.limit,
      offset: input.offset,
      order: 'desc',
    });
    return { transactions: rows };
  }),

  create: protectedProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    const { dbUser } = await requireAuth(ctx);

    // Ownership check: the account must belong to the authenticated user.
    // Cheap DB check rather than trusting the caller-provided userId.
    const accountRow = await db
      .select({ userId: schema.accounts.userId })
      .from(schema.accounts)
      .where(eq(schema.accounts.id, input.accountId))
      .limit(1);
    if (!accountRow[0] || accountRow[0].userId !== dbUser.id) {
      // `FORBIDDEN` rather than a raw Error — keeps the failure out of
      // the 5xx budget (bare throws surface as INTERNAL_SERVER_ERROR at
      // the tRPC boundary) and matches the rest of the codebase.
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Account does not belong to user' });
    }

    const repo = Container.get(HoldingTransactionRepository);
    const holdingService = Container.get(HoldingService);
    // Resolve or create the holding the manual entry attaches to. If
    // the user is entering a tx for an asset they never held via sync
    // (e.g. historical BTC buy that predates when they added this
    // account), we create a zero-balance holding so the ledger has an
    // anchor and the tx can be displayed under the right position.
    const holding = await holdingService.findOrCreateForIngest({
      userId: dbUser.id,
      accountId: input.accountId,
      tokenId: input.tokenId,
    });

    // Synthetic external_id covering every distinguishing field:
    // `(occurred_at, kind, quantity, holdingId)`. The dedup unique
    // constraint is (holding_id, source, external_id). Including
    // holdingId in the string makes the value self-describing in logs.
    const externalId = `manual:${input.occurredAt.toISOString()}:${input.kind}:${input.quantity}:${holding.id}`;

    const [created] = await repo.bulkUpsert([
      {
        userId: dbUser.id,
        holdingId: holding.id,
        tokenId: input.tokenId,
        kind: input.kind,
        quantity: input.quantity,
        priceNative: input.priceNative ?? null,
        priceNativeTokenId: input.priceNativeTokenId ?? null,
        counterTokenId: input.counterTokenId ?? null,
        counterQuantity: input.counterQuantity ?? null,
        feeQuantity: input.feeQuantity ?? null,
        feeTokenId: input.feeTokenId ?? null,
        occurredAt: input.occurredAt,
        externalId,
        source: 'user-entered',
        sourceMetadata: input.note ? { note: input.note } : {},
      },
    ]);

    return { transaction: created };
  }),

  delete: protectedProcedure.input(DeleteInput).mutation(async ({ ctx, input }) => {
    const { dbUser } = await requireAuth(ctx);
    // Ownership: only delete rows that belong to this user AND carry
    // source='user-entered'. Ingester-sourced rows are immutable from
    // the UI — their dedup key is what keeps them consistent.
    const row = await db
      .select({ id: schema.holdingTransactions.id })
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.id, input.id),
          eq(schema.holdingTransactions.userId, dbUser.id),
          eq(schema.holdingTransactions.source, 'user-entered')
        )
      )
      .limit(1);
    if (!row[0]) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Transaction not found or not deletable' });
    }
    await db.delete(schema.holdingTransactions).where(eq(schema.holdingTransactions.id, input.id));
    return { deleted: true };
  }),
});
