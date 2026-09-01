/**
 * `holdings.arrival` — whether a human ever picked this position (SC-277).
 *
 * `holdings.source` records which system wrote the row. It does not record
 * whether anyone chose to hold it, and on a public chain that is the whole
 * question: anyone can push tokens at an address. The wallet-import review
 * asks the user which arrivals to keep; the hourly `wallet-balances` sync
 * auto-discovers everything that lands afterwards and asks nobody. Both wrote
 * `source = 'blockchain'`.
 *
 * - `user_confirmed` — a human was shown this position or authored it.
 * - `auto_discovered` — a balance sync created it and nobody was asked. A
 *   claim about a machine, never about the token: of the production rows
 *   migration 0042 stamps, nearly all are airdropped junk and a couple are
 *   legitimate dust receipts (SOL, USDT). A signal to show, never a verdict to
 *   act on.
 * - `unattributed` — we cannot say. Every row that predates the column, minus
 *   the ones the backfill could prove. Never evidence in either direction.
 *
 * So a consumer must test for `auto_discovered` positively:
 * `arrival !== 'user_confirmed'` is true of 69 legacy rows that are mostly
 * ordinary holdings.
 */
export type HoldingArrival = 'user_confirmed' | 'auto_discovered' | 'unattributed';

/**
 * The arrivals a *writer* may claim. `unattributed` is missing on purpose, and
 * as of SC-326 that is enforceable rather than aspirational: it is a statement
 * about rows that predate the column, so no code that is creating a row can
 * truthfully assert it.
 *
 * It was assertable until SC-326. `ImportWalletAddressUseCase.execute` imported
 * every token a chain returned without showing the user any of them, so it could
 * claim neither `user_confirmed` nor `auto_discovered` honestly and was given
 * `unattributed` — correct for that path, but it left the value meaning two
 * things at once ("predates the column" OR "a live importer declined to say").
 * `execute` had no callers and was deleted; the value now has one meaning, and
 * this type is what keeps it that way.
 *
 * The column's DB-level default is still `'unattributed'`, which is the only
 * remaining way a new row can acquire it.
 *
 * **This used to add "and every create path in the tree requires `arrival`
 * explicitly, so nothing reaches that default by accident." That was false**
 * (SC-637). `CreateHoldingUseCase` inserted into `holdings` without it and
 * took the default — harmlessly, because it turned out to have zero importers
 * anywhere in the tree, which is also why nobody noticed. It is deleted now.
 *
 * The guarantee is not restored by that deletion, and saying so is the point:
 * `arrival` is `notNull().default(...)`, so it is OPTIONAL in Drizzle's insert
 * type and a new create path that omits it COMPILES. Measured — a probe
 * inserting a holding with no `arrival` type-checks clean. `HoldingsSyncHelper`
 * and the import use cases pass it because their own input types demand it, not
 * because the schema does.
 *
 * So: if you add a path that creates a `holdings` row, pass `arrival`. Nothing
 * will tell you that you forgot, and the row you get is indistinguishable from
 * one that predates the column.
 */
export type HoldingArrivalAttribution = Exclude<HoldingArrival, 'unattributed'>;
