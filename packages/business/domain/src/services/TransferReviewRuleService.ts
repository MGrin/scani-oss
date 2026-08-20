import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import type { RuleMarkPreview, TransferReviewRule, TransferReviewRuleVerdict } from '@scani/shared';
import {
  MAX_BULK_TRANSFER_ROWS,
  RULE_ANSWER_SOURCE,
  RULE_ASSERTED_DECISION,
  ruleAssertsDisposal,
} from '@scani/shared';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import Container, { Service } from 'typedi';
import {
  counterpartyKeySql,
  pendingPredicate,
  ruleWritablePredicate,
} from '../lib/transfer-review-queue';
import { TransferReviewService } from './TransferReviewService';

/**
 * Why a rule could not be authored, in terms the API can turn into a status.
 *
 * `gone` is the same union member the queue uses and means the same thing —
 * "not yours, not an outflow, or not a row anybody could have been looking
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 * The reader needs to be told that this transfer cannot have a rule, rather
 * than that it vanished.
 */
export type CreateRuleResult =
  | { ok: true; rule: TransferReviewRule }
  | { ok: false; reason: 'gone' }
  | { ok: false; reason: 'no_counterparty' }
  | { ok: false; reason: 'own_wallet'; counterparty: string }
  | { ok: false; reason: 'duplicate'; counterparty: string };

export interface CreateRuleInput {
  /**
   * The transfer the rule is being written **from**, not a counterparty.
   *
   * This is the containment for the whole feature and it is worth stating as a
   * type rather than a convention: the rule key is a field an attacker can
   * write to, so an API that accepted a key would let anything that can reach
   * it install a standing rule about a counterparty the user has never seen.
   * Taking a transaction id instead means the key is derived by this service
   * from a row the user owns, and a rule can only ever be authored about a
   * transfer that is in their own ledger and on their own screen.
   *
   * SC-381 makes the derivation do more than lowercase, which makes this
   * matter more rather than less: the key is now a normalization of the row's
   * destination, and the only way a caller can learn what it will be is to be
   * shown it — `PendingTransferReview.counterpartyKey`, computed by the same
   * expression on the same read.
   */
  transactionId: string;
  verdict: TransferReviewRuleVerdict;
  note: string;
}

/**
 * Standing rules about counterparties (SC-375, re-keyed by SC-381, given the
 * power to answer by SC-380).
 *
 * mgrin asked for "a rule about all the transfers to that address", and chose
 * *"auto-answer, but only on addresses I explicitly mark"* when asked whether
 * a rule may ever book a disposal unattended. SC-375 shipped the default half
 * — `not_a_disposal` and `ask_me`, neither of which writes a
 * `transfer_review`. **`always_a_disposal` is the marking, and it is the whole
 * of what "explicitly mark" means here: a third verdict, chosen per
 * destination, on an authoring path that is otherwise unchanged.**
 *
 * Marking is not a rule *type* the reader configures once and forgets, and it
 * is never inferred. There is no setting that makes new rules assert by
 * default, nothing derives the verdict from how similar rows were answered
 * before, and `always_a_disposal` is reachable only by choosing it against a
 * consequence line that quotes the money the mark is about to book — see
 * `markPreview`.
 *
 * **What contains a verdict that CAN book capital gains.** SC-375's safety
 * argument had two legs and this removes one of them; the migration states the
 * three properties that replace it in full. In this file the relevant one is
 * that `create` still takes a transaction id and never an address, so the key
 * is copied by the server off a row the caller owns, under `pendingPredicate`
 * — their own, an outflow, unpaired, unanswered, NON-ZERO. That last condition
 ***REMOVED***
 * adversary reaching this session still cannot mark a destination the user has
 * never sent real money to. The other two live in `ruleWritablePredicate`.
 *
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 *
 * Everything the engine does still happens at read time, in
 * `TransferReviewService`. For the two non-writing verdicts that is what makes
 * the undo trivial — a revoked rule stops matching and the rows it hid are
 * pending again, with nothing to un-write. For `always_a_disposal` it is not
 * enough and was never claimed to be: revoking stops future answers, `revoke`
 * reports how many rows it already owns, and it can withdraw them in the same
 * transaction. Per row, `reopen` is the undo and it is durable — see the
 * comment on it.
 */
@Service()
export class TransferReviewRuleService {
  /**
   * This user's active rules, newest first, each carrying how many queue rows
   * it currently applies to.
   *
   * The count is one grouped left join rather than a query per rule, and it
   * counts the *unanswered* set — `pendingPredicate` — because that is what a
   * rule can act on. A rule matching zero rows is the failure this feature is
   * most likely to have and the number is how a reader sees it: a rule keyed
   * on the `counterparty` column would today match nothing in production, and
   * a rule keyed on a whole payment description matched exactly one row
   * forever (SC-381). Both look identical to a rule with nothing to do.
   *
   * **`answeredCount` is the second number and it counts the opposite set**
   * (SC-380): rows this rule has already answered and still owns, found by
   * `transfer_review_rule_id` rather than by re-matching the key, so it does
   * not drift as the ledger changes and does not claim a row the reader has
   * since taken back. Both numbers are needed at once, because a marking rule
   * that has done its work has `affectedCount` 0 — nothing waiting — which is
   * exactly what a rule matching nothing looks like.
   *
   * Two correlated subqueries rather than a second grouped join: joining both
   * sets at once multiplies them, and a rule showing 23 × 4 is worse than a
   * rule showing nothing.
   */
  async list(userId: string): Promise<TransferReviewRule[]> {
    const rows = await db
      .select({
        rule: schema.transferReviewRules,
        affectedCount: sql<number>`count(${schema.holdingTransactions.id})::int`,
        answeredCount: sql<number>`(
          select count(*)::int
          from ${schema.holdingTransactions} answered
          where answered.transfer_review_rule_id = ${schema.transferReviewRules.id}
        )`,
      })
      .from(schema.transferReviewRules)
      .leftJoin(
        schema.holdingTransactions,
        and(
          pendingPredicate(userId),
          eq(schema.transferReviewRules.matchCounterparty, counterpartyKeySql)
        )
      )
      .where(
        and(
          eq(schema.transferReviewRules.userId, userId),
          isNull(schema.transferReviewRules.revokedAt)
        )
      )
      .groupBy(schema.transferReviewRules.id)
      .orderBy(desc(schema.transferReviewRules.createdAt));

    return rows.map((row) => toDto(row.rule, row.affectedCount, row.answeredCount));
  }

  /**
   * What marking this destination *"always a disposal"* would answer, and what
   * it would book — the confirmation this slice turns on (SC-380).
   *
   * Every other verdict is undone by revoking a rule that wrote nothing, so a
   * sentence was enough. This one books capital gains on transfers the reader
   * has not opened, and the measurement mgrin accepted when he asked for it is
   * that roughly one in twenty-three will be wrong, always toward a gain he did
   * not make (SC-345). A confirmation that could only say "some transfers"
   * would be asking him to authorize a number nobody had computed.
   *
   * The money comes from `bulkPreview` — the same pass SC-382's bulk apply
   * confirms with, over the same `marketValue` the queue shows per row as "if
   * it was a sale" — so nothing here is a figure the reader has not already
   * seen somewhere else.
   *
   * It also surfaces the refusals BEFORE the attempt, which is the point of
   * showing them: `own_wallet` in particular is a sentence about the reader's
   * own address book, and finding it out by having the write rejected teaches
   * them nothing about which address it was.
   */
  async markPreview(userId: string, transactionId: string): Promise<RuleMarkPreview> {
    const empty = {
      affectedCount: 0,
      proceedsInBase: null,
      unpricedCount: 0,
      baseCurrencyCode: '',
    };

    const [row] = await db
      .select({ counterpartyKey: counterpartyKeySql })
      .from(schema.holdingTransactions)
      .where(and(eq(schema.holdingTransactions.id, transactionId), pendingPredicate(userId)))
      .limit(1);
    if (!row?.counterpartyKey) {
      return { ...empty, counterpartyKey: null, refusal: 'no_counterparty' };
    }
    const counterpartyKey = row.counterpartyKey;

    const reviews = Container.get(TransferReviewService);
    const refusal = await this.markRefusal(userId, counterpartyKey, reviews);
    if (refusal) return { ...empty, counterpartyKey, refusal };

    // The rows the mark would reach, by the write gate itself rather than by a
    // paraphrase of it — so a preview can never promise a row the write would
    // decline.
    const targets = await db
      .select({ id: schema.holdingTransactions.id })
      .from(schema.holdingTransactions)
      .where(and(ruleWritablePredicate(userId), eq(counterpartyKeySql, counterpartyKey)))
      .limit(MAX_BULK_TRANSFER_ROWS);

    const preview = await reviews.bulkPreview(
      userId,
      targets.map((target) => target.id),
      RULE_ASSERTED_DECISION
    );

    return {
      counterpartyKey,
      affectedCount: preview.eligible.length,
      proceedsInBase: preview.proceedsInBase,
      unpricedCount: preview.unpricedCount,
      baseCurrencyCode: preview.baseCurrencyCode,
      refusal: null,
    };
  }

  /**
   * Write a rule about the destination of one of the user's transfers.
   *
   * The transfer must be one this queue could have shown them: their own, an
   * outflow, unpaired, unanswered and non-zero — `pendingPredicate` exactly.
   * Two of those conditions are the security argument rather than tidiness.
   * **Non-zero** excludes the 113 address-poisoning rows, which are the corpus
   * an attacker plants and the one set of rows that appears on no screen.
   * **Unanswered** keeps the rule engine on the side of the line SC-345 drew:
   * a rule never reads or writes a row that already carries an answer, which
   * is what makes "never overwrite a `user` answer" true by construction
   * rather than by check.
   */
  async create(userId: string, input: CreateRuleInput): Promise<CreateRuleResult> {
    // The key is SELECTED, not computed here, and that is the fix's other half
    // (SC-381). A rule works only if the string written at authoring time and
    // the string compared at read time are produced identically forever, and
    // the reliable way to say "identically" is "by the same expression" rather
    // than "by two implementations a test compares". SC-376 is the precedent:
    // one predicate, two call sites.
    const [row] = await db
      .select({ counterpartyKey: counterpartyKeySql })
      .from(schema.holdingTransactions)
      .where(and(eq(schema.holdingTransactions.id, input.transactionId), pendingPredicate(userId)))
      .limit(1);
    if (!row) return { ok: false, reason: 'gone' };

    const counterparty = row.counterpartyKey;
    if (counterparty === null) return { ok: false, reason: 'no_counterparty' };

    const reviews = Container.get(TransferReviewService);
    if (ruleAssertsDisposal(input.verdict)) {
      const refusal = await this.markRefusal(userId, counterparty, reviews);
      if (refusal === 'own_wallet') return { ok: false, reason: 'own_wallet', counterparty };
    }

    const [created] = await db
      .insert(schema.transferReviewRules)
      .values({
        userId,
        matchCounterparty: counterparty,
        verdict: input.verdict,
        note: input.note.trim(),
      })
      .onConflictDoNothing()
      .returning();
    // The partial unique index refused it: this user already has an active
    // rule on this counterparty. Reported with the key rather than as a
    // generic conflict, because the reader's next question is "which one" and
    // the answer is not on the screen they authored from — and after SC-381
    // the key is a normalization, so two visibly different payments legitimately
    // collide here.
    if (!created) return { ok: false, reason: 'duplicate', counterparty };

    // Applied here as well as at read time, and not as an optimisation: the
    // reader has just authorized a specific number of disposals against a
    // specific amount of money, and a rule that reported "0 answered" until
    // they navigated somewhere would be showing them a different transaction
    // than the one they confirmed. Evaluation is still one expression in one
    // place — this calls it, it does not reimplement it.
    const answered = ruleAssertsDisposal(input.verdict)
      ? await reviews.applyDisposalMarks(userId)
      : 0;

    return {
      ok: true,
      rule: toDto(created, await this.affectedCount(userId, counterparty), answered),
    };
  }

  /**
   * Why this destination may not be MARKED, or null.
   *
   * One method because `create` and `markPreview` must refuse identically: a
   * preview that says yes to something the write declines is worse than no
   * preview, and the refusal it exists to surface is the one a reader cannot
   * work out for themselves.
   *
   * The comparison is `ownWallets.has(key)` with no further normalization, and
   * that is correct rather than lucky: the key is already the output of
   * `transfer_counterparty_key` — trimmed and lowercased — and
   * `ownWalletAddresses` lowercases and trims the other side. For a chain
   * address the two normalizations are the same operation, which is what makes
   * this the same comparison `ownWalletCounterparty` makes at the write.
   */
  private async markRefusal(
    userId: string,
    counterpartyKey: string,
    reviews: TransferReviewService
  ): Promise<'own_wallet' | null> {
    const ownWallets = await reviews.ownWalletAddresses(userId);
    return ownWallets.has(counterpartyKey) ? 'own_wallet' : null;
  }

  /**
   * Take a rule out of force, and optionally take back what it answered.
   *
   * `revoked_at` rather than a delete: a rule that hid rows for a month is
   * history, and the row is the only record of why those transfers were not
   * being asked about. For `not_a_disposal` and `ask_me` that is still the
   * whole of the undo — nothing was ever written to their rows, so the next
   * read simply stops matching and they are pending again.
   *
   * **`always_a_disposal` is different and the difference is the trap** (SC-380).
   * Revoking stops the rule answering anything further; it does not un-answer
   * the transfers it has already booked as disposals, and a reader who assumed
   * otherwise would walk away leaving N realized gains behind believing they
   * had undone them. So the count comes back either way, for the surface to
   * state, and `withdrawAnswers` does the taking-back in the same transaction —
   * because 23 individual undos is precisely the tapping this feature exists to
   * remove, and an undo more tedious than the thing it reverses does not get
   * used.
   *
   * The withdrawal is gated on `transfer_review_source = 'rule'` as well as on
   * the rule id, which is the "never overwrite a `user` answer" rule applied in
   * the undo direction: a row the reader reopened and then answered themselves
   * carries their source, and revoking a rule must not reach into it. It clears
   * the source outright rather than leaving the `'user'` exemption marker,
   * because the marker means "a person overruled the rule on this row" and
   * nobody did — the rule is simply gone. Re-marking the destination later is a
   * fresh decision and may answer them again.
   *
   * No deposit to delete and no group to clear: `ruleWritablePredicate` admits
   * only link-free rows, so everything this can reverse is a pure column write
   * in the other direction — SC-382's argument, and the reason the reversal is
   * exact rather than best-effort.
   *
   * `ok: false` means "not yours, or already revoked". Both are the same
   * non-failure: the rule is not in force either way.
   */
  async revoke(
    userId: string,
    ruleId: string,
    opts: { withdrawAnswers?: boolean } = {}
  ): Promise<{ ok: boolean; withdrawn: number; answered: number }> {
    return db.transaction(async (tx) => {
      const [revoked] = await tx
        .update(schema.transferReviewRules)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.transferReviewRules.id, ruleId),
            eq(schema.transferReviewRules.userId, userId),
            isNull(schema.transferReviewRules.revokedAt)
          )
        )
        .returning({ id: schema.transferReviewRules.id });
      if (!revoked) return { ok: false, withdrawn: 0, answered: 0 };

      const owned = and(
        eq(schema.holdingTransactions.userId, userId),
        eq(schema.holdingTransactions.transferReviewRuleId, ruleId),
        eq(schema.holdingTransactions.transferReviewSource, RULE_ANSWER_SOURCE)
      );

      if (!opts.withdrawAnswers) {
        const [row] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(schema.holdingTransactions)
          .where(owned);
        return { ok: true, withdrawn: 0, answered: row?.count ?? 0 };
      }

      const withdrawn = await tx
        .update(schema.holdingTransactions)
        .set({
          transferReview: null,
          transferReviewSplit: null,
          transferReviewedAt: null,
          transferReviewSource: null,
          transferReviewRuleId: null,
          updatedAt: sql`now()`,
        })
        .where(owned)
        .returning({ id: schema.holdingTransactions.id });

      return { ok: true, withdrawn: withdrawn.length, answered: withdrawn.length };
    });
  }

  /** How many queue rows one counterparty key currently accounts for. */
  private async affectedCount(userId: string, counterparty: string): Promise<number> {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.holdingTransactions)
      .where(and(pendingPredicate(userId), eq(counterpartyKeySql, counterparty)));
    return row?.count ?? 0;
  }
}

/**
 * The row as the wire sees it.
 *
 * `verdict` is narrowed on the way out because the column is text: a value a
 * later version writes must not reach a UI that switches on it, and the safe
 * reading of an unknown verdict is the one that asks rather than the one that
 * hides — or, since SC-380, the one that answers.
 */
function toDto(
  rule: typeof schema.transferReviewRules.$inferSelect,
  affectedCount: number,
  answeredCount: number
): TransferReviewRule {
  return {
    id: rule.id,
    matchCounterparty: rule.matchCounterparty,
    // `ask_me` is the fallback and stays the fallback now that a third verdict
    // exists: an unknown value must never be read as the one that books a
    // disposal, and "keep asking" is the reading that costs nothing if wrong.
    verdict:
      rule.verdict === 'not_a_disposal'
        ? 'not_a_disposal'
        : rule.verdict === 'always_a_disposal'
          ? 'always_a_disposal'
          : 'ask_me',
    note: rule.note,
    createdAt: rule.createdAt.toISOString(),
    affectedCount,
    answeredCount,
  };
}
