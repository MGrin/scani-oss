import { sha256 } from './migration-files';

/**
 * SC-914. Editing the COMMENTS of a migration that has already run drifts its
 * recorded sha256 exactly as far as editing its SQL does, and the runner
 * refuses the whole deploy either way (SC-401). That refusal is correct and is
 * not softened here. What was missing is a way for a legitimate comment edit
 * to get through it without somebody hand-editing
 * `drizzle.__scani_migrations` with psql — which is the recovery two threads
 * reached for before, and the one the refusal message exists to displace.
 *
 * The instance that produced this file: three privacy commits rewrote comments
 * in 19 applied migrations so the mirrored tree would stop carrying real
 * account data. Production was reconciled by hand, twice, because the first
 * pass was taken before the last two of those commits merged and nobody
 * re-checked — `db:migrate` returned 1 for about an hour and every deploy was
 * blocked. A self-hoster upgrading across the same release meets the identical
 * refusal and has no table to reconcile from at all.
 *
 * ## What a declaration is, and what each half of it proves
 *
 * A declaration says: *this database recorded THIS digest for THIS migration,
 * and re-recording it against the file in this tree is safe because …*. The
 * runner acts on one only when both halves match, and both halves are checked
 * against things it can actually see:
 *
 *   - `recorded` is compared with the row in `drizzle.__scani_migrations`.
 *     A wrong value makes the declaration inert; it can never widen.
 *   - `sqlSha256` (`comment-only`) is compared with the non-comment SQL of the
 *     file **in this tree**, recomputed here. So a declaration cannot let
 *     through a file whose SQL is not the SQL it describes, whatever it
 *     claims.
 *
 * ## What it does NOT prove, stated rather than implied
 *
 * That the OLD file — the one that actually ran — had that same non-comment
 * SQL. The old text does not exist on the machine running the migration: the
 * database holds one digest of it, and `scani/migrate` ships the migrations
 * folder and nothing else. Storing the old text would prove it outright and
 * costs ~96 KB for these 19 alone, which is why it is not done.
 *
 * That claim is instead established where the old text DOES exist — in git, at
 * the moment the edit is made — by `cd packages/infra/db && bun run db:declare-drift`, which reads the
 * old blob, refuses to emit a `comment-only` entry unless the two strip equal,
 * and prints the entry to paste. **Derive the value that way.** Computing
 * `sqlSha256` from the NEW file instead produces something that passes here
 * and asserts nothing, which is the one way a real SQL change gets through
 * this path.
 *
 * ## `sql-changed`, and why the honest path for one exists
 *
 * `0045_sc331_deduplicate_evm_transactions.sql` is the case the comment rule
 * cannot cover: its executable SQL genuinely changed, so no comment-only
 * declaration is writable for it and the mechanism must refuse it. Refusing it
 * and stopping there would send the reader back to psql. So a second kind
 * exists, is deliberately more expensive to write — it pins the exact new
 * digest as well as the old one, so it stops applying the moment either side
 * moves — and prints its own reason at the point of use, every time, into the
 * deploy log.
 */

/** Same marker `applyMigrations` splits statements on. */
const BREAKPOINT = '--> statement-breakpoint';

const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

function isIdentifierChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/** The last word already emitted, lowercased — `''` when there is none. */
function lastWord(out: readonly string[]): string {
  const tail = out.join('').trimEnd();
  return /([A-Za-z_][A-Za-z0-9_]*)$/.exec(tail)?.[1]?.toLowerCase() ?? '';
}

/**
 * The SQL a migration actually executes, with every comment removed and
 * whitespace outside literals collapsed to single spaces.
 *
 * Whitespace has to collapse or the comparison is worthless: deleting a
 * three-line comment and writing a two-line one back leaves a different number
 * of blank lines, and a byte comparison would call that a SQL change.
 *
 * Two things are deliberately NOT treated as comments:
 *
 *   - `--> statement-breakpoint`, which is a comment to Postgres and an
 *     instruction to this runner. Dropping it would make two files that split
 *     into different statements — and three migrations here carry their own
 *     COMMIT — compare equal.
 *   - anything inside a string literal, a quoted identifier or a dollar-quoted
 *     body. A `--` inside a quoted string is data. Mistaking one for a comment
 *     deletes the rest of that line from both sides of the comparison, which
 *     is how a genuine difference would be hidden.
 */
export function sqlWithoutComments(sql: string): string {
  const out: string[] = [];
  let i = 0;

  const pushSpace = (): void => {
    if (out.length > 0 && out[out.length - 1] !== ' ') out.push(' ');
  };

  while (i < sql.length) {
    if (sql.startsWith(BREAKPOINT, i)) {
      pushSpace();
      out.push(BREAKPOINT);
      out.push(' ');
      i += BREAKPOINT.length;
      continue;
    }

    const ch = sql[i] as string;

    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      pushSpace();
      continue;
    }

    if (ch === '/' && sql[i + 1] === '*') {
      // Postgres nests block comments, so depth is counted rather than
      // stopping at the first `*/`.
      let depth = 0;
      while (i < sql.length) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else {
          i++;
        }
      }
      pushSpace();
      continue;
    }

    if (ch === '$') {
      const opener = DOLLAR_TAG.exec(sql.slice(i))?.[0];
      // `$1` and `$body$` both start with `$`; only the second is a quote.
      if (opener && !isIdentifierChar(sql[i - 1])) {
        const end = sql.indexOf(opener, i + opener.length);
        const stop = end === -1 ? sql.length : end + opener.length;
        const body = sql.slice(i + opener.length, end === -1 ? sql.length : end);
        // `DO $$ … $$` and `AS $$ … $$` are dollar-quoted to the SQL parser
        // and CODE to the reader: three migrations here carry their
        // preconditions in a `DO` block, comments and all, and a scrub that
        // rewrites one of those comments has changed no executable SQL. Any
        // other dollar-quoted run is data and is copied byte for byte — a
        // `--` inside it is two characters of a value, not a comment.
        const isCode = lastWord(out) === 'do' || lastWord(out) === 'as';
        out.push(opener);
        out.push(isCode ? sqlWithoutComments(body) : body);
        out.push(opener);
        i = stop;
        continue;
      }
    }

    if (ch === "'" || ch === '"') {
      // `E'…'` is the one string form where a backslash escapes the closing
      // quote; a plain literal doubles it instead.
      const escaped = ch === "'" && (sql[i - 1] === 'E' || sql[i - 1] === 'e');
      out.push(ch);
      i++;
      while (i < sql.length) {
        if (escaped && sql[i] === '\\' && i + 1 < sql.length) {
          out.push(sql.slice(i, i + 2));
          i += 2;
          continue;
        }
        if (sql[i] === ch) {
          out.push(ch);
          i++;
          if (sql[i] === ch) {
            out.push(ch);
            i++;
            continue;
          }
          break;
        }
        out.push(sql[i] as string);
        i++;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      pushSpace();
      i++;
      continue;
    }

    out.push(ch);
    i++;
  }

  return out.join('').trim();
}

interface DeclarationBase {
  /** The migration whose recorded digest may be re-recorded. */
  tag: string;
  /** The digest the database recorded when it ran. Anything else: inert. */
  recorded: string;
  /** Why this is safe, printed into the deploy log every time it fires. */
  why: string;
}

interface CommentOnlyDeclaration extends DeclarationBase {
  kind: 'comment-only';
  /**
   * `sqlSha256` of the file AS IT RAN. Derive it with
   * `cd packages/infra/db && bun run db:declare-drift <tag>`, never from the edited file.
   */
  sqlSha256: string;
}

interface SqlChangedDeclaration extends DeclarationBase {
  kind: 'sql-changed';
  /**
   * The exact digest of the file this was written against. Pinning it is what
   * keeps a deliberate override from silently covering the NEXT edit too.
   */
  becomes: string;
}

export type DriftDeclaration = CommentOnlyDeclaration | SqlChangedDeclaration;

const SCRUB_COMMENTS =
  'SC-912/SC-915 replaced real account data in this migration with synthetic ' +
  'examples so the mirrored tree stops carrying it. Comments only.';

const SCRUB_0045 =
  'SC-916 replaced production identifiers this migration carried in EXECUTABLE ' +
  'SQL, not in comments — so no comment-only declaration is writable for it. ' +
  'Re-recording it is safe because no database will ever run either version ' +
  'again: every statement below the precondition names ids measured on one ' +
  'database, and the precondition itself returns early where there is no EVM ' +
  'ledger and raises on any population other than the measured one. The only ' +
  'database that predicate ever admitted has already applied the old text. The ' +
  'edit narrows rather than widens — the guard now names an address no real row ' +
  'carries — and the statement list, order and column lists are unchanged.';

/**
 * Every declaration in force. Adding one is a reviewed change to this file;
 * there is no runtime flag, no environment variable and no operator prompt,
 * because the thing this replaces is somebody asserting "the schemas match"
 * while looking at a red deploy.
 */
export const DRIFT_DECLARATIONS: readonly DriftDeclaration[] = [
  {
    kind: 'comment-only',
    tag: '0004_merge_mistyped_equity_dupes',
    recorded: '59f3da31da44c7f7b3df987c23b495694d3a7d29b44c20ea3955e62f75307c6e',
    sqlSha256: 'b61bb661e69aa0a71b3c9dc31c69728d4969b037d12b77fc1b3b9b85496428c4',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'comment-only',
    tag: '0008_clear_bogus_reconciliation_openings',
    recorded: '960df2c2235dc074788e0e2d81f231807fc049638116e73100c0324eb0e7364a',
    sqlSha256: '08b75f6809dab2b400619ffd8796eda2befdd14104e8e5fde9a13f06ee82496a',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'comment-only',
    tag: '0036_token_lookalike_of',
    recorded: '3c8cbfa7e29533ce02a57e010d83c1126ed159c3e46872da7d0a99ab0edd4120',
    sqlSha256: '92227576929354cf8399ecccacd935345a2a312f3f1b7049e05b4e2d11a46193',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'comment-only',
    tag: '0037_portfolio_anchor_provenance',
    recorded: '4362adc6f59347bd991cd55726c449f3725023160f57cd56159560e0f48604d2',
    sqlSha256: 'b1b83a43c880680124738f6fe21f1d2fbabf1e0464d49225921fdd6ce4ea789a',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'comment-only',
    tag: '0040_scam_score_version',
    recorded: '095b9f67b9d165c676af923c7b1ded87a26160c4bd7c25d3edd504909de6a360',
    sqlSha256: '32cc0b14acd7f3c3d339c6a24917fbf0d91d5c240539dff2a1df93a8ac3f938e',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'comment-only',
    tag: '0042_holding_arrival',
    recorded: 'be44bb6990a537070355064a64901c97e81e970b0d3b7f8a0121dcfd7237581f',
    sqlSha256: 'b2c681013e1fb5b683a8c10807ceca430c4efd651d1ac81fbb04a2384524b5d4',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'comment-only',
    tag: '0043_holdings_external_id_unique',
    recorded: 'ebf54c86c7d455c096c76db4363e251bdf7b23f57774d9a6ac5288224c0e01ec',
    sqlSha256: '86c21a73b2b1f929ffe9801d997b7e6fd391cedc7637d9ba164c2ca6a4a447d3',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'comment-only',
    tag: '0044_sc328_pair_kraken_eth_withdrawals',
    recorded: '259e6759f12f472cb05c7d8c60c2d2e170da4ff6968e990bf88ac9e90df01f81',
    sqlSha256: '03cd464079594d598fc558c56e5e9012469bb6e291c5cbc0efaff40b38e241cf',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'sql-changed',
    tag: '0045_sc331_deduplicate_evm_transactions',
    recorded: '253f58a515778764765b9301565b1c9bf82e1ac3db5070ca8b1fe2d536b4d612',
    becomes: '0856b733e0162a0b8954e26fe5b34bd608a496b78a00216e3d0483d91eca489a',
    why: SCRUB_0045,
  },
  {
    kind: 'comment-only',
    tag: '0046_holding_label',
    recorded: '5be61cc46d03095d519332446ebad1c635a410c983139b4663e450ec9bc7a0d0',
    sqlSha256: '0b4ef04baa9349579f34e54033adb11f5cc9032ea8855d46602c3d8ec7f7c899',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'comment-only',
    tag: '0048_transfer_review_source',
    recorded: 'c1479b4f4cdb74cde36a27b094dac0585be6e5fa0737b90478f6032c4295854c',
    sqlSha256: 'b2c24e7852527dcaa3d20995343498b24a82c76447de3dce70113f15d9c2239f',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'comment-only',
    tag: '0049_sc339_sc352_drop_restated_solana_rows',
    recorded: '7b1a677ee4ed3472be3ecba2cc0f41be2001db801eb4057198bd54bc87c12de6',
    sqlSha256: '8b73150eecef8d5fee8303c970f693f70108bd9c5c5cce0bf38b04979780b09b',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'comment-only',
    tag: '0050_sc357_rekey_solana_to_net_per_token',
    recorded: '6ff6718ca7fadff3276560fe90a45f1a4eb874ee9a64850d2828b6cfa916c238',
    sqlSha256: 'aecf103e859fd9b26dc7198c3f09567e4674fbfab46197a367dfbe432325c57d',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'comment-only',
    tag: '20260818021506_transfer_review_rules_keyed_on_counterparty_address',
    recorded: 'e9f53587e1a8adac401512b8f382b013f7dac31ad16daaa3d47d8d60863e2bad',
    sqlSha256: 'a86d40cc54595a1e662cb3d1f365828b7c5f2aeb679f0f7e58a5b19bab8cd68f',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'comment-only',
    tag: '20260818033355_transfer_review_rules_key_on_a_normalized_counterparty_identity',
    recorded: '8a87a5bd495bed86f1e83919f9ef8b9e52914d5117c365d9c432b3420c94b1dd',
    sqlSha256: '74b33907a240bdf46ef248ef4e551b85fd5c1beae2effb06ea6614e4839b88a0',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'comment-only',
    tag: '20260818051746_sc380_transfer_review_rules_that_answer',
    recorded: '3fe4c6ed838c65eb09064b031654a42187c372f7224b0f7e6c871539d162de85',
    sqlSha256: '8f0cfcf8556a54a52c4618146158825ae0287b557845e61cb0fd2e5fc96e5c5e',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'comment-only',
    tag: '20260818210004_sc393_drop_holding_coverage_observation_bounds',
    recorded: 'a0b4bd6d8214ad6b7acc161c583aee3bb0c52b5bc17a9df8ea2e1cb6a9c1ddbd',
    sqlSha256: '0357ff86e69d0542b051b34ab1089e92afe7622e9f511ea13933880b41c5a4cb',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'comment-only',
    tag: '20260821022557_sc475_portfolio_value_daily_holdings_interpolated',
    recorded: '8e6f357a2a45414597fc1b33155c47342c9916ab7b31bbc8705d9166c5efbbe1',
    sqlSha256: 'f2359509f9f1c3526b0c30061ba8a1a05e7001e19ecd2cd68e32d4a7ce6ba730',
    why: SCRUB_COMMENTS,
  },
  {
    kind: 'comment-only',
    tag: '20260822064054_sc501_balance_observation_gap_review',
    recorded: '6023761815ab1bdfbf11a25989349895075a6339ba1a2f3820ceeb23100f9518',
    sqlSha256: '3af262c1ffea40c6574346e736b5f3099dd7ac7d7124a6570fd2a2ccb415ab78',
    why: SCRUB_COMMENTS,
  },
];

export interface AppliedDigest {
  tag: string;
  /** What the database recorded. */
  recorded: string;
  /** What the file in this tree hashes to now — '' when there is no file. */
  found: string;
}

export interface PlannedReconciliation {
  tag: string;
  from: string;
  to: string;
  declaration: DriftDeclaration;
}

export interface ReconciliationPlan {
  reconcile: PlannedReconciliation[];
  /** Drift no declaration covers. The run still refuses on these. */
  refuse: AppliedDigest[];
  /**
   * Declarations that named a drifted tag and did not apply, with the reason.
   * Reported so "I wrote one and nothing happened" is never silent.
   */
  rejected: Array<{ declaration: DriftDeclaration; because: string }>;
}

/**
 * Decides, per drifted migration, whether a declaration lets it through.
 *
 * `sqlByTag` is the non-comment SQL of the file in this tree, keyed by tag —
 * passed in rather than read here so the caller keeps the one read of the
 * migrations folder it already did.
 */
export function planReconciliation(
  drifted: readonly AppliedDigest[],
  sqlByTag: ReadonlyMap<string, string>,
  declarations: readonly DriftDeclaration[] = DRIFT_DECLARATIONS
): ReconciliationPlan {
  const reconcile: PlannedReconciliation[] = [];
  const refuse: AppliedDigest[] = [];
  const rejected: Array<{ declaration: DriftDeclaration; because: string }> = [];

  for (const entry of drifted) {
    const candidates = declarations.filter(
      (declaration) => declaration.tag === entry.tag && declaration.recorded === entry.recorded
    );
    if (candidates.length === 0) {
      refuse.push(entry);
      continue;
    }

    let applied = false;
    for (const declaration of candidates) {
      const because = rejectionReason(declaration, entry, sqlByTag.get(entry.tag));
      if (because) {
        rejected.push({ declaration, because });
        continue;
      }
      reconcile.push({
        tag: entry.tag,
        from: entry.recorded,
        to: entry.found,
        declaration,
      });
      applied = true;
      break;
    }
    if (!applied) refuse.push(entry);
  }

  return { reconcile, refuse, rejected };
}

function rejectionReason(
  declaration: DriftDeclaration,
  entry: AppliedDigest,
  fileSql: string | undefined
): string | null {
  if (fileSql === undefined) {
    return 'the migration is not in this tree, so there is nothing to re-record it against';
  }
  if (declaration.kind === 'comment-only') {
    const found = sha256(fileSql);
    if (found !== declaration.sqlSha256) {
      return (
        'the file’s non-comment SQL is not what the declaration describes ' +
        `(declared ${short(declaration.sqlSha256)}, this tree has ${short(found)}) — ` +
        'so this is a SQL change, not a comment edit'
      );
    }
    return null;
  }
  if (declaration.becomes !== entry.found) {
    return (
      `it was written against ${short(declaration.becomes)} and this tree has ` +
      `${short(entry.found)} — the file has been edited again since`
    );
  }
  return null;
}

function short(hash: string): string {
  return hash ? `${hash.slice(0, 12)}…` : '<no file>';
}

/** The line printed for each reconciliation, into the deploy log. */
export function describeReconciliation(planned: PlannedReconciliation): string {
  const kind =
    planned.declaration.kind === 'comment-only'
      ? 'comments only, non-comment SQL verified identical'
      : 'DECLARED SQL CHANGE';
  return (
    `\u{1F527} ${planned.tag}: recorded digest ${short(planned.from)} → ` +
    `${short(planned.to)} (${kind})\n     ${planned.declaration.why}`
  );
}
