/**
 * Transfer-review router (SC-150).
 *
 * Its own router rather than three procedures on `review`, for the reason
 * that router's doc gives: the feed is a read-model and an item's actions
 * live with the record that owns them. The record here is a
 * `holding_transactions` row, and this is its surface.
 */

import type {
  BulkResolveResult,
  CreateRuleResult,
  SplitResolveResult,
} from '@scani/domain/services';
import {
  MalformedCursorError,
  TransferReviewRuleService,
  TransferReviewService,
} from '@scani/domain/services';
import {
  bulkTransferDecisionSchema,
  bulkTransferEntriesSchema,
  MAX_BULK_TRANSFER_ROWS,
  transferDestinationRefSchema,
  transferReviewDecisionSchema,
  transferReviewRuleNoteSchema,
  transferReviewRuleVerdictSchema,
  transferReviewSplitSchema,
} from '@scani/shared';
import { TRPCError } from '@trpc/server';
import Container from 'typedi';
import { z } from 'zod';
import { strictInput } from '../lib/strict-input';
import { protectedProcedure, router } from '../trpc';

const resolveInput = z
  .object({
    transactionId: z.string().uuid(),
    decision: transferReviewDecisionSchema,
    /** Required for `paired` and meaningless otherwise — checked here rather
     *  than left to the service so a malformed call fails at the boundary. */
    matchTransactionId: z.string().uuid().optional(),
    /** The same, for `internal` (SC-187). */
    destination: transferDestinationRefSchema.optional(),
  })
  .refine((v) => v.decision !== 'paired' || Boolean(v.matchTransactionId), {
    message: 'Pairing a transfer requires the matching deposit',
    path: ['matchTransactionId'],
  })
  .refine((v) => v.decision !== 'internal' || Boolean(v.destination), {
    message: 'Moving a transfer requires the holding it moved to',
    path: ['destination'],
  });

/**
 * One refusal, one status, for both answer shapes.
 *
 * `destination_gone` is deliberately not folded into the generic NOT_FOUND
 * (SC-187): "that transfer is no longer waiting" would send the reader away
 * from a question they can still answer, when what actually happened is that
 * one row in the picker went away and they need to pick again.
 */
function refuse(result: Exclude<SplitResolveResult, { ok: true }>): never {
  switch (result.reason) {
    case 'gone':
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'That transfer is no longer waiting for review',
      });
    case 'partner_gone':
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'That deposit is already linked to another transfer',
      });
    case 'destination_gone':
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'That holding is no longer there — pick where the money went again',
      });
    // The one refusal that contradicts the reader rather than the world
    // (SC-365), so it says what it knows and what to do instead. `left_control`
    // realizes a gain, and the destination is a wallet they registered
    // themselves — the money is still theirs. `untracked` is the answer for a
    // wallet Scani cannot see into, and it books nothing.
    case 'own_wallet_destination':
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          `${result.address} is one of your own wallets, so this did not leave your portfolio. ` +
          'Pair it with the deposit, say it moved to a holding you track, or mark it untracked.',
      });
    case 'sum':
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `The parts must add up to ${result.expected}`,
      });
    default:
      throw new TRPCError({ code: 'BAD_REQUEST', message: result.message });
  }
}

/**
 * One refusal, one status, for the bulk write path (SC-382).
 *
 * A CONFLICT rather than a NOT_FOUND, because nothing here is missing: the
 * rows are all still on the reader's screen and the batch was refused as a
 * whole. The message names the first row's reason and counts the rest, and the
 * client re-previews — which repaints the confirmation with the refusals
 * itemised against the rows, where they can actually be acted on.
 *
 * It only fires on a race. The preview the reader confirmed already showed
 * every refusal the gates knew about; reaching here means one appeared in the
 * seconds between, which for this queue means the nightly matcher claimed a
 * row or a second tab answered it.
 */
function refuseBulk(result: Exclude<BulkResolveResult, { ok: true }>): never {
  const [first, ...rest] = result.refusals;
  const reason =
    first?.reason === 'own_wallet'
      ? `${first.detail} is one of your own wallets`
      : first?.reason === 'answered_otherwise'
        ? `one is already answered "${first.detail}"`
        : first?.reason === 'linked'
          ? 'one is already linked to a deposit'
          : 'one is no longer waiting for review';
  throw new TRPCError({
    code: 'CONFLICT',
    message:
      rest.length > 0
        ? `Nothing was changed — ${reason}, and ${rest.length} more cannot be answered this way.`
        : `Nothing was changed — ${reason}.`,
  });
}

/**
 * One refusal, one status, for the rule write path.
 *
 ***REMOVED***
 ***REMOVED***
 * record does not say where the money went, and Solana rows carry no payload
 * at all — and "that transfer is gone" would be false about a row still
 * sitting in front of the reader. The correct sentence is that this particular
 * transfer cannot have a rule.
 */
function refuseRule(result: Exclude<CreateRuleResult, { ok: true }>): never {
  switch (result.reason) {
    case 'gone':
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'That transfer is no longer waiting for review',
      });
    case 'no_counterparty':
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'This transfer does not record where the money went, so there is nothing to make a rule about',
      });
    // The SC-350 refusal, raised from one answer to a standing sentence. Ten
    // `left_control` answers on addresses in his own `user_wallets` booked
    // 10,500 of disposals on money that never left the portfolio; a rule that
    // marked one of those addresses would be that mistake with a repeat count.
    // Named in the message, because "one of your wallets" leaves the reader to
    // work out which — and the two they most need to tell apart differ in one
    // character.
    case 'own_wallet':
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `${result.counterparty} is one of your own wallets, so transfers to it are not disposals`,
      });
    default:
      throw new TRPCError({
        code: 'CONFLICT',
        message: `You already have a rule for ${result.counterparty}`,
      });
  }
}

/**
 * Standing rules about a counterparty (SC-375, re-keyed by SC-381).
 *
 * A sub-router rather than three procedures alongside `resolve`, because the
 * record is a different one: those act on a `holding_transactions` row and
 * these act on a `transfer_review_rules` row. It is nested under
 * `transferReview` rather than mounted at the top level because a rule is
 * meaningless outside this queue — it has exactly one reader.
 *
 * **`create` takes a transaction id and not a key, and that is the feature's
 * containment rather than an API-shape preference.** The rule key is derived
 * from the counterparty field, which an attacker can write to — address
 * poisoning sprays zero-value transfers to plant a lookalike in a victim's
 * history. An endpoint that accepted a key would let anything reaching this
 * session install a standing rule about a counterparty the user has never
 * seen. Taking a transaction id means the key is derived by the service from a
 * row the user owns, which is the same thing as "a rule may only be authored
 * from a row on screen", enforced where it cannot be skipped. SC-381 makes
 * that key a normalization rather than a copy, so `listPending` carries
 * `counterpartyKey` — the reader confirms the string the rule will actually
 * match, not the one this payment happened to say.
 *
 * **SC-380 removes the other half of SC-375's containment and it is worth
 * being precise about what is gone.** The verdict enum used to hold only
 * `not_a_disposal` and `ask_me`, neither of which writes a `transfer_review`,
 * so the worst an adversary bought was a suppressed question. `always_a_disposal`
 * books capital gains, which mgrin authorized by name — *"only on addresses I
 * explicitly mark"* — and what still contains it is the paragraph above plus
 * `ruleWritablePredicate`: the key is never typed, so a mark can only ever be
 * placed on a destination the reader's own non-zero unanswered outflow already
 * names; the write gate refuses any row that carries a `transfer_review_source`,
 * so a `user` answer cannot be overwritten and a withdrawn one cannot be
 * re-answered; and the group-id gate rides along with `pendingPredicate`, so
 * the 29 matcher-linked rows that read as answered while booking nothing
 * (SC-382) are unreachable. Marking one of the reader's own wallets is refused
 * outright.
 */
const rulesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) =>
    Container.get(TransferReviewRuleService).list(ctx.userId)
  ),

  /** The transfers a `not_a_disposal` rule is currently keeping out of the
   *  queue. A rule removes a question; it must not remove a row. */
  listHidden: protectedProcedure.query(async ({ ctx }) =>
    Container.get(TransferReviewService).listHiddenByRule(ctx.userId)
  ),

  /**
   * What marking this transfer's destination *"always a disposal"* would
   * answer, and what it would book (SC-380).
   *
   * A separate call from `listPending` rather than a field on the row: it is a
   * per-destination aggregate with a price lookup per matched transfer, and the
   * queue already pays one of those per row it shows. Nobody needs it until
   * they open the authoring dialog, and then they need it before they can
   * consent to anything.
   */
  markPreview: protectedProcedure
    .input(strictInput(z.object({ transactionId: z.string().uuid() })))
    .query(async ({ ctx, input }) =>
      Container.get(TransferReviewRuleService).markPreview(ctx.userId, input.transactionId)
    ),

  create: protectedProcedure
    .input(
      strictInput(
        z.object({
          transactionId: z.string().uuid(),
          verdict: transferReviewRuleVerdictSchema,
          /** Required, and required for a reason: a 42-character hex string is
           *  not something a person recognises, and the note is what the reader
           *  will actually be reading three years from now. */
          note: transferReviewRuleNoteSchema,
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      const result = await Container.get(TransferReviewRuleService).create(ctx.userId, {
        transactionId: input.transactionId,
        verdict: input.verdict,
        note: input.note,
      });
      if (!result.ok) refuseRule(result);
      return result.rule;
    }),

  /**
   * Take the rule out of force, and say what that did and did not undo.
   *
   * For `not_a_disposal` and `ask_me` this is still the whole undo: nothing was
   * written to their rows, so the next read simply stops matching. For
   * `always_a_disposal` it is not, and the reply says so in a number — `answered`
   * is how many transfers the rule has booked as disposals and is returning
   * unchanged. A revoke that reported success while leaving N realized gains
   * behind would be the reader believing they had undone something they had
   * not (SC-380).
   *
   * `withdrawAnswers` takes them back in the same transaction. It is an
   * explicit choice rather than the default because the two intentions are
   * genuinely different — "I do not want this rule applying to future
   * transfers" and "everything this rule ever concluded was wrong" — and only
   * the second should reopen months of settled answers.
   */
  revoke: protectedProcedure
    .input(
      strictInput(
        z.object({ ruleId: z.string().uuid(), withdrawAnswers: z.boolean().default(false) })
      )
    )
    .mutation(async ({ ctx, input }) => {
      const result = await Container.get(TransferReviewRuleService).revoke(
        ctx.userId,
        input.ruleId,
        {
          withdrawAnswers: input.withdrawAnswers,
        }
      );
      if (!result.ok) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That rule is no longer in force' });
      }
      return result;
    }),
});

export const transferReviewRouter = router({
  listPending: protectedProcedure.query(async ({ ctx }) =>
    Container.get(TransferReviewService).listPending(ctx.userId)
  ),

  /**
   * Where an `internal` answer can send this transfer (SC-187).
   *
   * Per-transaction rather than a plain holdings list because the set depends
   * on the row: same token, and never the holding it left. Its own query
   * rather than a field on `listPending` because it is only needed once a
   * reader opens one row, and paying for every row's destination list on a
   * queue of hundreds would be the candidate search's cost a second time.
   */
  listDestinations: protectedProcedure
    .input(strictInput(z.object({ transactionId: z.string().uuid() })))
    .query(async ({ ctx, input }) =>
      Container.get(TransferReviewService).listDestinations(ctx.userId, input.transactionId)
    ),

  /**
   * The same list, addressed by HOLDING, for the balance-edit dialog (SC-606).
   *
   * It lives on this router rather than on `holdings` because what it returns
   * is a transfer-review destination — same shape, same picker, same rules
   * about which accounts appear — and the answer it feeds is written to
   * `transfer_review`. Filing it under holdings would put half of one
   * question's vocabulary in each of two routers.
   *
   * Asked before any outflow exists, which is the whole point: the edit and
   * its answer are one transaction, so there is no transaction id to address
   * yet.
   */
  listDestinationsForHolding: protectedProcedure
    .input(strictInput(z.object({ holdingId: z.string().uuid() })))
    .query(async ({ ctx, input }) =>
      Container.get(TransferReviewService).listDestinationsForHolding(ctx.userId, input.holdingId)
    ),

  /**
   * A NOT_FOUND here covers "not yours", "not an outflow" and "already
   * answered" alike. The last is the common one — two tabs on the same queue
   * — and it is not a failure: the question really is gone. The client
   * refetches on error, so the row simply disappears.
   */
  resolve: protectedProcedure.input(strictInput(resolveInput)).mutation(async ({ ctx, input }) => {
    const result = await Container.get(TransferReviewService).resolve(
      ctx.userId,
      input.transactionId,
      input.decision,
      {
        ...(input.matchTransactionId ? { matchTransactionId: input.matchTransactionId } : {}),
        ...(input.destination ? { destination: input.destination } : {}),
      }
    );
    if (!result.ok) refuse(result);
    return { ok: true };
  }),

  /**
   * The same question, answered about parts of the transaction (SC-181).
   *
   * Its own procedure rather than an optional field on `resolve`, because the
   * two inputs have nothing in common past the transaction id: one carries a
   * decision and maybe a partner, the other carries a list of amounts whose
   * sum is the thing being checked. Folding them together would produce an
   * input where half the fields are conditionally meaningless and a refine
   * chain nobody can read.
   *
   * **The sum is enforced here, not only in the form.** The shape rules live
   * in `transferReviewSplitSchema` at this boundary; the arithmetic one needs
   * the row, so it runs inside the service's transaction against the very
   * quantity being divided. A 400 carrying the expected total is the useful
   * failure — the reader typed two numbers and one of them is wrong.
   */
  resolveSplit: protectedProcedure
    .input(
      strictInput(
        z.object({
          transactionId: z.string().uuid(),
          split: transferReviewSplitSchema,
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      const result = await Container.get(TransferReviewService).resolveSplit(
        ctx.userId,
        input.transactionId,
        input.split
      );
      if (result.ok) return { ok: true };
      refuse(result);
    }),

  /**
   * The answers already given, keyset-paginated (SC-241).
   *
   * `limit` caps at 100 and the reply carries `nextCursor`, null on the last
   * page. It used to take no input at all and return a fixed 200, which is how
   * 379 of one user's 579 answered rows became unreachable.
   */
  listAnswered: protectedProcedure
    .input(
      strictInput(
        z
          .object({
            limit: z.number().int().min(1).max(100).default(25),
            cursor: z.string().min(1).optional(),
            /** Token, account, institution or counterparty — matched over every
             *  answered row rather than the page the caller holds (SC-244). */
            search: z.string().max(200).optional(),
          })
          .default({})
      )
    )
    .query(async ({ ctx, input }) => {
      try {
        return await Container.get(TransferReviewService).listAnswered(ctx.userId, input);
      } catch (error) {
        if (error instanceof MalformedCursorError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
        }
        throw error;
      }
    }),

  /**
   * What one answer applied to these transfers would do, in money (SC-382).
   *
   * A query rather than a field on the mutation, because the reader has to see
   * it BEFORE committing and `left_control` is the only answer that books a
   * disposal — twelve of them on one tap is the most consequential thing this
   * product can be asked to do. It is also the only way the answered list can
   * state money at all: `listAnswered` carries no price by design.
   */
  bulkPreview: protectedProcedure
    .input(
      strictInput(
        z.object({
          transactionIds: z.array(z.string().uuid()).min(1).max(MAX_BULK_TRANSFER_ROWS),
          /** `null` previews the undo — putting the rows back in the queue. */
          decision: bulkTransferDecisionSchema.nullable(),
        })
      )
    )
    .query(async ({ ctx, input }) =>
      Container.get(TransferReviewService).bulkPreview(
        ctx.userId,
        input.transactionIds,
        input.decision
      )
    ),

  /**
   * One answer, many transfers, all or nothing (SC-382).
   *
   * The input is per-row rather than "these ids, this decision" for one
   * reason: the undo is this same procedure, called with the answers the first
   * call replaced. A uniform-decision input would have needed a second
   * endpoint to express a reversal, and two write paths into the same columns
   * is how one of them stops stamping attribution.
   */
  bulkResolve: protectedProcedure
    .input(strictInput(z.object({ entries: bulkTransferEntriesSchema })))
    .mutation(async ({ ctx, input }) => {
      const result = await Container.get(TransferReviewService).bulkResolve(
        ctx.userId,
        input.entries
      );
      if (!result.ok) refuseBulk(result);
      return { applied: result.applied };
    }),

  rules: rulesRouter,

  reopen: protectedProcedure
    .input(strictInput(z.object({ transactionId: z.string().uuid() })))
    .mutation(async ({ ctx, input }) => {
      const ok = await Container.get(TransferReviewService).reopen(ctx.userId, input.transactionId);
      if (!ok) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That transfer has not been reviewed' });
      }
      return { ok };
    }),
});
