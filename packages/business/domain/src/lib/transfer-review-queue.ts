import * as schema from '@scani/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { OUTFLOW_KINDS } from './transfer-matching';

/**
 * The queue, as a predicate. Defined once because five callers ask the same
 * question and a badge that disagrees with its own page is the failure
 * `useReviewFeed` was written to end.
 *
 * It moved out of `TransferReviewService` when rules arrived (SC-375): the
 * rule engine has to count the rows a rule applies to, which is this set
 * exactly, and a second copy of "unanswered outflow, unpaired, non-zero" would
 * be a rules list reporting about a queue nobody else has.
 *
 * **This is the set a person may still answer, and rules do not narrow it.**
 * What a rule narrows is `queueVisibility` below — what the queue *shows*.
 * Keeping the two apart is what lets a reader answer a hidden row from the
 * hidden list instead of having to revoke a rule to reach their own transfer.
 */
export function pendingPredicate(userId: string) {
  return and(
    eq(schema.holdingTransactions.userId, userId),
    inArray(schema.holdingTransactions.kind, [...OUTFLOW_KINDS]),
    isNull(schema.holdingTransactions.transferGroupId),
    isNull(schema.holdingTransactions.transferReview),
    // A zero-quantity outflow moves nothing, so no answer to it can change
    // anything: `walkComponent` pops no lots for it and every branch of
    // `isConfirmedDisposal` books the same nothing. Asking about one spends
    // the reader's attention on a question with one answer (SC-346).
    //
    // It is a hundred or so rows in production, every one an `etherscan` USDC/USDT
    // `tokentx` row, and THEY ARE CORRECTLY ZERO. A zero-value
    // `transferFrom` costs an attacker nothing and emits a real `Transfer`
    // log on the real USDC/USDT contract, so address poisoning sprays them
    // across thousands of wallets to plant a lookalike address in the
    // victim's history. Ours is party to one leg of each, at value 0.
    //
    // An earlier version of this comment claimed they were the native record
    // of an ERC-20 call colliding with the token record on
    // `hash-contract`, and that SC-341 was therefore the disease behind
    // them. THAT WAS WRONG, twice over, and it cost a later reader a day.
    // A native leg's `externalId` is the bare `hash` and an internal leg's
    // is `hash-internal-<trace>`, so neither can ever collide with a token
    // row. SC-341 was real but token-vs-token, and fixing it recovered 13
    // legs while turning exactly none of these zeros into an amount: all
    // 112 that predated the fix still read 0, with their `external_id`
    // untouched. Confirmed against `eth_getTransactionReceipt` for all 727
    // EVM hashes in the ledger — for 113 of the 114 zero rows every
    // upstream `Transfer` log at that `(hash, contract, wallet)` is value 0,
    // and the one exception's non-zero sibling is stored as its own row.
    //
    // So this hides nothing and waits on nothing. The rows are accurate and
    // unanswerable — nobody can say where a zero went — which is the whole
    // case for keeping them out of a queue whose count is supposed to reach
    // zero and mean something. `spam-filter.ts` cannot help: it matches on
    // token name and symbol, and poisoning rides a legitimate contract.
    //
    // It is also the reason a rule may not be authored from one of these
    // rows: they are the address-poisoning corpus itself, and they appear on
    // no screen, so a rule keyed off one could not have been read by anybody.
    sql`${schema.holdingTransactions.quantity}::numeric <> 0`
  );
}

/**
 * The rows a standing rule may WRITE an answer onto (SC-380).
 *
 * `pendingPredicate` and one more column, and the extra column is the whole of
 * the per-row undo. Both halves are load-bearing and neither is a courtesy
 * check somebody has to remember to make:
 *
 * **What `pendingPredicate` already contributes**, and the reason the write
 * gate is defined in terms of it rather than spelled out again: it excludes
 * rows that carry a `transfer_group_id`. 29 of production's 236 unanswered
 * outflows are in exactly that state — matcher-paired, invisible to the queue —
 * and `CostBasisService.outflowPortions` reads `transferGroupId` BEFORE
 * `isConfirmedDisposal`, so a `left_control` written onto one books nothing
 * while reading as answered (SC-382). A rule engine with its own copy of
 * "unanswered" would write into that state silently. It has no copy.
 * `pendingPredicate` also excludes the 113 zero-quantity address-poisoning
 * rows, which is why a rule cannot assert a disposal on the corpus an attacker
 * plants.
 *
 * **`transfer_review_source IS NULL`** is stricter than `transfer_review IS
 * NULL` on purpose, and it does two jobs at once. It makes "never overwrite an
 * answer stamped `user`" true by construction rather than by check — such a row
 * fails on both columns. And it makes the per-row undo permanent: `reopen` on a
 * rule-answered row clears the decision but leaves the source reading `'user'`,
 * so a row the reader has overruled is a row this predicate can never select
 * again. Without it the undo would be a loop — take the answer back, read the
 * queue, watch the rule put it straight back.
 *
 * The same asymmetry protects a `repair` withdrawal: `withdrawSameHoldingPairing`
 * leaves `'repair'` behind precisely to say the row is open for the USER to
 * answer, and a rule answering it instead would take that question away.
 */
export function ruleWritablePredicate(userId: string) {
  return and(pendingPredicate(userId), isNull(schema.holdingTransactions.transferReviewSource));
}

/**
 * The key a rule is matched on, in SQL: this queue's destination, put through
 * `transfer_counterparty_key` (SC-375, re-keyed by SC-381).
 *
 * Two layers, and both are load-bearing.
 *
 * **Where the destination comes from.** `counterparty` first, the payload's
 * `to` second. The column is NULL on all 249 etherscan, 87 solana and 88
 * kraken outflows in production, so an expression reading only the column
 * would match nothing, complete successfully, and look exactly like a user
 * with no rules — SC-329's bug shape. `nullif` twice: an empty stored column
 * falls through to the payload, and a destination that normalizes to the empty
 * string is not a destination. The `->> 'to'` is safe to hardcode because
 * `pendingPredicate` restricts `kind` to `OUTFLOW_KINDS`, and for every one of
 * those the counterparty is `to`.
 *
 * **What it is normalized to.** `transfer_counterparty_key` — the SQL function
 * the migration defines — trims, lowercases, and strips a `Pay <amount> <CCY>
 * to ` preamble. SC-375 lowercased and stopped there, which was right for the
 * data it was designed for and wrong for the only data it can reach: every
 * populated `counterparty` in production is prose from a payment rail, and it
 * leads with the amount, so a rule keyed on the whole description matched the
 * payment it was written from and no later one to the same person.
 *
 * Matching is still exact full-string equality on the result, and that is the
 * point rather than a leftover. The key is a field an attacker can write to,
 * so a prefix match, an `ilike`, or a match on the truncated form the UI
 * renders would each turn "plant a lookalike in the victim's history" into
 * "make the victim's own rule fire on it".
 *
 * The normalization lives in the database and not here because the failure
 * mode of a derived key is the two ends drifting apart. Everything that needs
 * the key — this join, the affected-row count, the authoring path that copies
 * it off the caller's own row, and the migration that re-keyed the rules
 * already written — reads this one expression, and this expression calls one
 * function. `TransferReviewService.test.ts` still asserts SQL and TypeScript
 * agree row-for-row on the *displayed* counterparty, which is the other half:
 * a reader authorizing a rule has to be shown the string the rule will be
 * about.
 */
export const counterpartyKeySql = sql<string | null>`transfer_counterparty_key(
  coalesce(
    nullif(${schema.holdingTransactions.counterparty}, ''),
    ${schema.holdingTransactions.rawPayload} ->> 'to'
  )
)`;

/**
 * The join condition that pairs a queue row with the user's active rule for
 * its destination, if there is one.
 *
 * A LEFT JOIN rather than two EXISTS subqueries because both readers of a rule
 * need the rule itself — the queue shows an `ask_me` note on the row, and the
 * hidden list names the rule that took it. It cannot fan a row out: the
 * partial unique index allows one active rule per (user, key).
 *
 * Matching is exact, full-string equality against `counterpartyKeySql`, which
 * is where the argument for that lives.
 */
export function activeRuleJoin(userId: string) {
  return and(
    eq(schema.transferReviewRules.userId, userId),
    isNull(schema.transferReviewRules.revokedAt),
    eq(schema.transferReviewRules.matchCounterparty, counterpartyKeySql)
  );
}
