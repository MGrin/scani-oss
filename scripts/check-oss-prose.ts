#!/usr/bin/env bun
// Report PROSE that describes our own deployment on lines bound for
// MGrin/scani-oss. Advisory: it names the line and never refuses.
//
// WHY THIS EXISTS (SC-909). `check-oss-figures.ts` says in its own header that
// it cannot read prose, and that limitation is reachable through the most
// ordinary route there is — writing a good comment explaining WHY a change
// exists, using the incident that motivated it. A draft carried an incident's
// evidence verbatim into code comments, a database migration and a pull
// request body: a count, a percentage of a monitoring window, a named
// credential, a claim about what the running system had never done. Every file
// it touched travels to the mirror. It was caught by one person reading their
// own diff.
//
// The three checks beside this one all passed it and were each right to:
// `check-oss-bound-paths.ts` answers which FILES may travel,
// `check-oss-internal-refs.ts` looks for references with no legitimate
// published use, and `check-oss-figures.ts` reads decimal literals on added
// lines. A sentence of accurate English describing a live system is none of
// those things.
//
// A MIGRATION COMMENT IS PERMANENT, WHICH IS WHY THIS IS NOT A DOCUMENTATION
// PROBLEM. `scripts/migrate.ts` refuses the whole run on sha256 drift, for an
// edited applied migration and for a deleted one, with no escape flag. Once a
// migration is applied its text cannot be rewritten, so there is no later at
// which a sentence in one gets fixed.
//
// WHY NOT A KEYWORD LIST, WHICH IS THE OBVIOUS BUILD. Blocking a vendor name is
// wrong here and would be switched off inside a week: monitoring vendors are
// supported integrations of the public product and their names are spread over
// a hundred mirrored files — the SDK, the env schema, the CSP. The
// distinguishing property is not the vendor, it is SPECIFICITY ABOUT OUR OWN
// DEPLOYMENT. So a sentence is reported only when it carries BOTH:
//
//   a SCOPE signal   — the sentence is about our running system
//   a SPECIFIC signal — a measurement, or a claim of never
//
// NEITHER AXIS ALONE SURVIVES CONTACT WITH THE TREE, and that is the whole
// calibration. Measured with this file's own `--scan` against `upstream/main`
// 2026-09-01, over 53,229 sentences of comment and markdown prose in 2,228
// files:
//
//   the SCOPE axis alone         620 sentences in 359 files  (16% of files)
//   the SPECIFIC axis alone      907 sentences in 376 files  (17% of files)
//   both, in the same sentence    63 sentences in  56 files  ( 2% of files)
//
// A rule on either axis fires on a sixth of the repository on its first run,
// which is a guard switched off inside a week. Requiring one from each takes it
// to 0.12% of the sentences read.
//
// ON THE FLOW, which is what somebody actually experiences: 9 of the last 400
// merges on the private `main` carry a claim, 23 in total — about one merge in
// forty. That rate is what an advisory can cost without being tuned out.
//
// WHAT A REPORTED SENTENCE MEANS, and it stops deliberately short of a verdict:
// this sentence is specific about the running system, and it is going to be
// public. Whether that is a defect is a judgement about the sentence, and it is
// why this check has no refusal and no escape variable — there is nothing to
// switch off, so it cannot decay into a guard somebody disabled.
//
// The same reticence covers the 63 above. Nobody has judged them one way or the
// other, and asserting a verdict about them inside a published file would put a
// claim in the mirror that no person has signed.
//
// STATED LIMITS, because a check trusted for more than it does is worse than
// none:
//
//   IT READS SENTENCES, NOT PARAGRAPHS. A scope word in one sentence and a
//   figure in the next is not reported. That is the calibration, not an
//   oversight — widening to the paragraph makes a long docblock co-occur by
//   accident.
//
//   IT CANNOT SEE A NAMED CREDENTIAL or an account label. Those carry no
//   measurement and no scope word, and they were half of the near-miss that
//   produced this. Read the comments yourself as well.
//
//   THAT SENTENCE USED TO NAME A PERSON'S NAME AS A THIRD, AND IT WAS WRONG
//   IN THE DIRECTION THAT MATTERS (SC-1131). Nine sentences across seven
//   published files asserted that a figure had been taken off one real
//   account, and they DID carry measurements — so a reader meeting the old
//   wording would have concluded this class was already accounted for and
//   stopped looking. A name standing alone carries nothing; a name beside a
//   verb of observation is a scope signal, and it is one now.
//
//   IT IS DEFEATED BY A REWORDING, and that limit outlives every vocabulary
//   change made to it. This reads the words the claims that have been made
//   are made of; the same fact said differently passes. A GREEN RUN IS NOT
//   EVIDENCE THAT NO REAL FIGURE IS PUBLISHED. It is a tripwire on the shapes
//   that have happened, never a proof about the shapes that have not.
//
//   IT CATCHES THREE OF THOSE NINE, MEASURED RATHER THAN ASSUMED, AND THE SIX
//   IT MISSES HAVE TWO DIFFERENT CAUSES. An earlier draft of this paragraph
//   attributed all six to the sentence-scope limit above. That was wrong about
//   one of them, and a wrong explanation written into a stated limit is worse
//   than none: it tells the next reader the class is accounted for.
//
//   FIVE are a missing axis in their own sentence — a money amount with no
//   scope word beside it, or a claim of realness with no figure beside it.
//   That is the sentence-scope limit, and the only rule that would reach them
//   keys on a pronoun, which fires on the stock.
//
//   THE SIXTH WAS NOT A LIMIT OF THIS VOCABULARY AT ALL, and it is the worst
//   of the nine. It fires BOTH axes as written, and one of the two is a signal
//   that predates this widening entirely — so the rules always reached it. It
//   was missed because it was never handed to them: the extractor was anchored
//   on the comment sigil, a JSX comment opens with a brace before the sigil,
//   and a brace is not whitespace, so that line and every unprefixed
//   continuation line inside the block read as code. Over fifteen hundred
//   lines of tracked `.tsx` and `.jsx` were unreadable for that reason, and
//   the money screens are largely made of them.
//
//   SC-1135 REPAIRED THE EXTRACTION, separately and with a replay of its own:
//   see the block-comment limits below. So the guard now catches FOUR of the
//   nine, and the five it misses are all the first cause, which is still a
//   limit. Reading the two causes as one is what this paragraph exists to
//   prevent.
//
//   IT DOES NOT READ PULL REQUEST BODIES. The same text in a PR description
//   reaches the same audience and no hook sees it.
//
//   A BLOCK COMMENT IS READ BY STATE, NOT BY LINE (SC-1135). A continuation
//   line of a `/* */` block written without a leading `*` — every JSX comment
//   is one — carries no marker, and neither does a line of JSX text, so only
//   whether a block is open tells them apart. Two limits follow from that:
//
//   OVER A DIFF, A LINE INSIDE A BLOCK IS READ ONLY WHEN ITS OPENER IS ALSO
//   ADDED. The hook sees added lines and nothing else, so one sentence edited
//   in the middle of an existing block arrives with no opener before it and
//   reads as code. `--scan` reads whole files and has no such gap.
//
//   A BLOCK OPENED AFTER CODE ON THE SAME LINE IS NOT READ — `<p>{/*` with the
//   comment below it. The anchor is what keeps a `//` inside a URL from being a
//   comment, and relaxing it for `/*` alone would read a glob or a regex in an
//   expression as the start of a block.
//
// It is a seatbelt on the machine doing the work, not a gate on the repository:
// `--no-verify` skips the hook, and a fresh clone has no hooks until
// `bun install` sets `core.hooksPath`.
//
// Usage:
//   bun scripts/check-oss-prose.ts                    # staged additions
//   bun scripts/check-oss-prose.ts --stdin-commits    # additions in commits named on stdin
//   bun scripts/check-oss-prose.ts --scan             # every tracked file — the AUDIT mode,
//                                                     # deliberately not wired into any hook

import { existsSync, readFileSync } from 'node:fs';
import {
  type AddedLine,
  addedLines,
  collectBranchFacts,
  countUnread,
  isScannable,
  refArg,
} from './check-oss-figures';
import { type RepoFacts, scanScope } from './check-oss-internal-refs';
import { EXIT_OK, EXIT_UNKNOWN, type GitRun, runGit, unreadClause } from './lib/check-verdict';

export { EXIT_OK, EXIT_UNKNOWN };

/**
 * The guard could not verify itself. Its own code rather than {@link EXIT_OK},
 * because an instrument that cannot demonstrate it still works has not checked
 * anything — and never a refusal, because it says nothing about the content
 * that was staged. Matches both siblings.
 */
export const EXIT_SELF_TEST_FAILED = 10;

/**
 * A signal on one of the two axes.
 *
 * `probe` is a string it MUST match and `antiProbe` one it must NOT, both
 * checked before anything is read. Every rule here reads zero on an ordinary
 * branch, so a green run and a pattern that has silently stopped matching
 * produce identical output without them — the exact failure this file is about,
 * sitting inside the file.
 *
 * EVERY PROBE IS INVENTED. This file is published, so a probe quoting a real
 * measurement would be the leak it exists to report, committed permanently
 * inside the guard against it. `98,765` is a descending keyboard run.
 * `check-oss-figures.ts` reached the same conclusion after first drafting the
 * opposite, and its docblock is worth reading before anyone changes these.
 */
export interface Signal {
  readonly name: string;
  readonly pattern: RegExp;
  readonly probe: string;
  readonly antiProbe: string;
}

/**
 * THE SENTENCE IS ABOUT OUR RUNNING SYSTEM.
 *
 * Each of these was measured against the mirror before it was added, and two
 * candidates were REJECTED on that measurement rather than on taste. A
 * time-boxed window (`over the last 30 days`, `a 30-day window`) reads 17 lines
 * upstream and every one is a third-party API's paging cap or a chart's axis
 * label — it describes somebody else's system, not ours. `never once` on its
 * own reads 11, all of them ordinary English about code that was not exercised.
 * Both are the shape of a rule that looks right and fires on the stock.
 */
export const SCOPE: readonly Signal[] = [
  {
    name: 'in production',
    pattern: /\b(?:in|on) production\b/i,
    probe: 'we saw it in production twice',
    antiProbe: 'a production build is minified and the producer exits',
  },
  {
    name: 'production did something',
    pattern: /\bproduction (?:carried|carries|has|had|is|was|never|holds?|held)\b/i,
    probe: 'production held two of them',
    antiProbe: 'production builds are minified and production of the report is slow',
  },
  {
    name: 'our deployment',
    pattern:
      /\bour (?:production|prod|monitoring|observability|telemetry|alerting|deployment|infrastructure)\b/i,
    probe: 'our monitoring shows it clearly',
    antiProbe: 'our code, our tests and our own error handling',
  },
  {
    name: 'our volume',
    pattern:
      /\bour (?:error|event|alert|log|traffic|request|exception|job|queue)\s+(?:volume|count|rate|budget|backlog)\b/i,
    probe: 'it is most of our error volume',
    antiProbe: 'our error handling and our job descriptors',
  },
  {
    name: 'the live system',
    pattern: /\bthe live (?:account|database|system|data|api|deployment)\b/i,
    probe: 'read from the live database',
    antiProbe: 'a live region, live data binding and the live query hook',
  },
  {
    /**
     * NAMING THE VENDOR IS NOT THE SIGNAL — the vendor beside a measurement is.
     * That distinction is the whole reason this check is not a blocklist, and
     * it is measured: these names read 100-odd mirrored files as integrated
     * dependencies, and one single sentence pairs one with a measurement.
     *
     * The analytics vendor goes deliberately unnamed, for the reason
     * `check-oss-internal-refs.ts` gives: the private-side marker list treats
     * that name as private content, so spelling it out in a published file
     * would make this rule an instance of what it reports.
     */
    name: 'a hosting or monitoring vendor',
    pattern: /\b(?:sentry|fly\.io|neon|cloudflare|upstash)\b/i,
    probe: 'Sentry grouped them as one issue',
    antiProbe: 'sentries at the gate and a neonatal ward',
  },
  {
    /**
     * A FIGURE READ OFF ONE PARTICULAR BOOK (SC-1131).
     *
     * The bare phrase was measured and rejected on the same footing as the two
     * candidates above: `real account` alone reads twenty-five sentences in
     * twenty-two tracked files and nearly every one is ordinary test prose
     * about *a* real account. THE ARTICLE IS THE DISCRIMINATOR — a definite or
     * possessive determiner makes it a reference to one particular book, and
     * an indefinite one makes it a category, which is why `a` is absent from
     * the alternation and its absence is load-bearing.
     *
     * With the SPECIFIC axis also required the determined form reads one
     * sentence across the whole tracked tree. That is the answer to the worry
     * that a phrase list of this kind cannot be narrowed: the narrowing is not
     * done by the phrase, it is done by the second axis.
     */
    name: 'our real account',
    pattern:
      /\b(?:the|his|her|their|my|our) (?:real|live|actual|genuine|production) (?:account|book|portfolio|wallet|ledger|holdings?|balances?|spread)\b/i,
    probe: 'measured on the real account',
    antiProbe: 'a real account of the outage, our production build and the live query hook',
  },
  {
    /**
     * A NAMED PERSON OBSERVING OUR RUNNING SYSTEM (SC-1131).
     *
     * This is a CORRECTION to a limit this file used to state rather than an
     * addition beside it. The old wording said a person's name could not be
     * seen because it carries neither a measurement nor a scope word. That is
     * true of a name standing alone and false of one beside a verb of
     * observation — which is exactly what a figure read off somebody's own
     * book looks like once it is written down, and one of the sentences that
     * reached the mirror had that shape.
     *
     * The verb list is observation only. A name beside a RULING, a preference
     * or an objection is a product decision and is nobody's balance, so those
     * verbs are deliberately absent; `read` is absent too, because it matches
     * inside `read-only` and would fire on a replica.
     */
    name: 'a person read it off our system',
    pattern:
      /\bmgrin\b[^.]{0,80}\b(?:opened|saw|noticed|observed|checked|reported)\b|\b(?:reported|observed|measured) by mgrin\b/i,
    probe: 'mgrin opened the dashboard and noticed it',
    antiProbe: "mgrin's ruling on variable payments: print the count and invent nothing",
  },
];

/**
 * A MEASUREMENT, OR A CLAIM OF NEVER.
 *
 * A bare run of digits is deliberately absent. It was in the first draft and it
 * is what a reasonable person reaches for; measured, it takes the report from
 * 62 sentences to 187, and the 125 it adds are ticket keys, line numbers and
 * years. Three digits in a row is not a measurement — a thousands separator, a
 * percent sign or a counted noun is.
 */
export const SPECIFIC: readonly Signal[] = [
  {
    name: 'a grouped number',
    pattern: /\b\d{1,3}(?:,\d{3})+\b/,
    probe: 'it was 98,765 of them',
    antiProbe: 'a list of 1, 2 and 3 on 2026-01-31 at 400 wide',
  },
  {
    name: 'a percentage',
    pattern: /\b\d+(?:\.\d+)?\s*%/,
    probe: 'that is 12% of the total',
    antiProbe: 'it grew by a percent and the % sign is escaped',
  },
  {
    /**
     * The lookbehind is not tidiness — it is the one false positive this rule
     * produced over 400 merges. `SC-751 records that as missing` reads as *751
     * records*, because a ticket key ends in digits and `records` is as much a
     * verb as a noun. An `SC-` reference is the single commonest token in this
     * repository's prose, so a counted-noun rule without this fires on the
     * vocabulary the mirror is made of.
     */
    name: 'a counted noun',
    pattern:
      /(?<![\w-])\d+\s+(?:events?|errors?|exceptions?|alerts?|incidents?|rows?|users?|accounts?|transactions?|records?|jobs?|occurrences?|holdings?|tokens?|legs?|observations?|captures?)\b/i,
    probe: 'exactly 7 rows survived',
    antiProbe: 'SC-751 records it, taking 7 files and 3 retries over 2 attempts',
  },
  {
    name: 'a claim of never',
    pattern: /\bnever once\b|\bnot once (?:has|have|did|was)\b/i,
    probe: 'it has never once fired',
    antiProbe: 'it never fired and was not run once more',
  },
  {
    /**
     * THE SHAPE THAT ACTUALLY REACHED THE MIRROR (SC-1131), and not one of the
     * four rules above saw it. A bare money amount is not a grouped number, not
     * a percentage, not a counted noun and not a claim of never — so of the
     * nine sentences later redacted from seven published files, EIGHT fired
     * nothing at all on this axis. The ticket was filed believing all nine
     * failed the SCOPE axis alone; measured, eight failed both.
     *
     * THE NINTH IS THE INSTRUCTIVE ONE and an earlier draft of this comment
     * denied it existed, saying zero of the nine fired here. It carries a
     * thousands separator, so it fires `a grouped number`, which predates this
     * rule — and it went unnoticed because the population was gathered THROUGH
     * the extractor, which could not read the JSX comment it sits in until
     * SC-1135. A measurement taken through the instrument under test reports
     * the instrument's blind spot as an absence in the world.
     *
     * A LONE DIGIT AFTER THE SIGIL IS EXCLUDED, and that is not tidiness. A
     * shell positional has the shape of an amount, and `proseOf` reads a
     * leading `--` as a comment, so a `case` arm handling a long option arrives
     * here as prose and matched on the first draft.
     */
    name: 'a currency amount',
    pattern: /\$\s?\d(?:[\d,.]*\d|\s?[km]\b)/i,
    probe: 'it settled at $98,765 that month',
    antiProbe: `pass $1 and $2 through, and read \${PORT} from the environment`,
  },
  {
    /**
     * A VALUE STATED AS AN ASSIGNMENT (SC-1131) — the way a measurement taken
     * off one real row gets written into a comment.
     *
     * Anchored on the `=` or the `:`, because a BARE decimal is not a
     * measurement here: it reads over a thousand sentences across the tracked
     * tree and fires on every version number and every duration, which is the
     * ground the two rejected candidates in {@link SCOPE} were rejected on.
     * Anchored, it costs three sentences.
     */
    name: 'a stated value',
    pattern: /[=:]\s*\d+\.\d+/,
    probe: 'it held total_value = 98.76 for that row',
    antiProbe: 'at 12:30 it shipped version 1.2 with a 0.5s budget',
  },
  {
    /**
     * A RUN OF VALUES IN ONE SENTENCE (SC-1131) — a measurement transcribed off
     * several real rows rather than one threshold quoted from the code beside
     * it. Two decimals with no sentence end between them costs six sentences
     * once a scope signal is also required, which is what makes it affordable
     * where the bare decimal above is not.
     *
     * The lookarounds reject a dotted version, which is the only shape that
     * reads as two decimals and is neither.
     */
    name: 'a run of stated values',
    pattern: /(?<![\w.])\d+\.\d+(?![\w.])[^.]{0,60}?(?<![\w.])\d+\.\d+(?![\w.])/,
    probe: 'the three buckets scored 0.98, 0.76 and 0.54',
    antiProbe: 'bun 1.3.14 and version 2.0.1 both shipped',
  },
];

export const SIGNAL_COUNT = SCOPE.length + SPECIFIC.length;

/** Every signal that has stopped behaving as written, in the order declared. */
export function verifySignals(signals: readonly Signal[]): string[] {
  const broken: string[] = [];
  for (const s of signals) {
    if (!s.pattern.test(s.probe)) broken.push(`${s.name}: stopped matching its own probe`);
    if (s.pattern.test(s.antiProbe)) broken.push(`${s.name}: now matches its anti-probe`);
  }
  return broken;
}

export function selfTest(): string[] {
  return verifySignals([...SCOPE, ...SPECIFIC]);
}

/** Exported so a test can hand `verifySignals` a signal that is deliberately broken. */
export type { Signal as SignalType };

/**
 * Where a line opening `/*` IS a comment. Everywhere else it need not be: a
 * Pages `_headers` rule and a `.gitignore` entry both start that way, and
 * entering a block there would read the rest of the file as prose.
 */
const BLOCK_COMMENT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.sql',
];

function hasBlockComments(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return (
    dot > path.lastIndexOf('/') && BLOCK_COMMENT_EXTENSIONS.includes(path.slice(dot).toLowerCase())
  );
}

interface LineRead {
  readonly prose: string | null;
  /** Whether the NEXT line starts inside an open `/* … *\/`. */
  readonly inBlock: boolean;
}

function nonEmpty(body: string): string | null {
  const t = body.trim();
  return t === '' ? null : t;
}

/**
 * One line, given whether it starts inside an open block comment (SC-1135).
 *
 * THE STATE IS THE WHOLE FIX. A continuation line of a JSX comment, or of any
 * `/* *\/` block not written with a leading `*`, carries no marker at all — it
 * is indented English, and so is a line of JSX text. Nothing on the line tells
 * the two apart; only whether a block is open does. So the opener is read
 * where it is anchored, `{/*` included, and the lines after it are prose until
 * the `*\/` — and never a line after that.
 */
function readLine(path: string, line: string, inBlock: boolean): LineRead {
  if (path.endsWith('.md') || path.endsWith('.mdx')) {
    const t = line.trim();
    // A fence or a table rule carries no sentence, and a code block inside
    // markdown is code — the same reason only comments are read elsewhere.
    if (t === '' || t.startsWith('```') || t.startsWith('|'))
      return { prose: null, inBlock: false };
    return { prose: t, inBlock: false };
  }
  if (hasBlockComments(path)) {
    if (inBlock) {
      const close = line.indexOf('*/');
      const body = (close === -1 ? line : line.slice(0, close)).replace(/^\s*\*?/, '');
      return { prose: nonEmpty(body), inBlock: close === -1 };
    }
    const open = /^(\s*\{?\s*)\/\*+/.exec(line);
    if (open !== null) {
      // Searched from just past the `/*`, so `/**/` closes where it opens.
      const close = line.indexOf('*/', (open[1] ?? '').length + 2);
      const body = line.slice(open[0].length, close === -1 ? undefined : close);
      return { prose: nonEmpty(body), inBlock: close === -1 };
    }
  }
  const m = /^\s*(?:\/\/+|#+|--|\*|\/\*+|<!--)\s?(.*?)\s*(?:\*\/|-->)?\s*$/.exec(line);
  return { prose: m === null ? null : nonEmpty(m[1] ?? ''), inBlock: false };
}

/**
 * The prose carried by one line READ ON ITS OWN, or `null` when it is not
 * prose. A continuation line of a block comment is `null` here by
 * construction — see {@link proseOfLines}, which is what the scan uses.
 *
 * Comment bodies and markdown, and nothing else, because the value axis is
 * already `check-oss-figures.ts`'s. Anchored at the start of the line so a
 * `//` inside a URL and a `--` inside an expression are not comments.
 */
export function proseOf(path: string, line: string): string | null {
  return readLine(path, line, false).prose;
}

/** The prose carried by each of a run of CONSECUTIVE lines of one file. */
export function proseOfLines(path: string, lines: readonly string[]): (string | null)[] {
  let inBlock = false;
  return lines.map((line) => {
    const r = readLine(path, line, inBlock);
    inBlock = r.inBlock;
    return r.prose;
  });
}

/**
 * Sentences, from a run of prose lines joined back into a paragraph.
 *
 * Splitting on a terminator over-splits an abbreviation, and that direction is
 * the safe one: it can only make two signals fail to meet, never make two
 * unrelated ones meet.
 */
export function sentencesOf(block: readonly string[]): string[] {
  return block.join(' ').split(/(?<=[.!?])\s+/);
}

export interface Claim {
  readonly scope: string;
  readonly specific: string;
  readonly sentence: string;
}

/** The first signal from each axis, when one sentence carries both. */
export function readSentence(sentence: string): Claim | null {
  const scope = SCOPE.find((s) => s.pattern.test(sentence));
  if (scope === undefined) return null;
  const specific = SPECIFIC.find((s) => s.pattern.test(sentence));
  if (specific === undefined) return null;
  return { scope: scope.name, specific: specific.name, sentence: sentence.trim() };
}

export interface Finding extends Claim {
  readonly path: string;
  /** 1-indexed, the first line of the prose block, so it can be pasted after a colon. */
  readonly line: number;
}

/**
 * A block is a run of CONTIGUOUS prose lines in one file.
 *
 * Contiguity is what makes this correct over a diff: an added line that is not
 * adjacent to the previous one belongs to a different hunk, and joining two
 * hunks into a paragraph would manufacture a sentence nobody wrote. An open
 * block comment does not survive a gap either, for the same reason — whatever
 * lies between the two hunks may have closed it.
 */
export function findInLines(lines: readonly AddedLine[]): {
  findings: Finding[];
  sentences: number;
} {
  const findings: Finding[] = [];
  let sentences = 0;
  let block: string[] = [];
  let blockPath = '';
  let blockLine = 0;
  let previous: { path: string; line: number } | null = null;
  let inBlock = false;

  const flush = (): void => {
    if (block.length === 0) return;
    for (const sentence of sentencesOf(block)) {
      sentences++;
      const claim = readSentence(sentence);
      if (claim !== null) findings.push({ ...claim, path: blockPath, line: blockLine });
    }
    block = [];
  };

  for (const l of lines) {
    const contiguous =
      previous !== null && previous.path === l.path && l.line === previous.line + 1;
    const read = readLine(l.path, l.text, contiguous && inBlock);
    inBlock = read.inBlock;
    const prose = read.prose;
    if (prose === null || !contiguous) flush();
    if (prose !== null) {
      // The block's own first line, captured when it OPENS. Carrying it over
      // from a flushed block is what reported line 0 on the first draft.
      if (block.length === 0) {
        blockPath = l.path;
        blockLine = l.line;
      }
      block.push(prose);
    }
    previous = { path: l.path, line: l.line };
  }
  flush();
  return { findings, sentences };
}

/** Every claim in whole file content, for `--scan`. */
export function findInContent(
  path: string,
  content: string
): { findings: Finding[]; sentences: number } {
  const lines = content.split('\n');
  return findInLines(lines.map((text, i) => ({ path, line: i + 1, text })));
}

/**
 * The population, as one diff or as a reason there is none.
 *
 * A git that FAILED is {@link EXIT_UNKNOWN}, never an empty diff. `git diff
 * --cached` legitimately returning nothing and `git diff` dying are not the
 * same fact and both arrive as `''`; only the first is a scan with nothing in
 * it (SC-775).
 */
function population(cwd: string, fromCommits: readonly string[] | null): GitRun {
  if (fromCommits === null) {
    return runGit(['diff', '--cached', '--unified=0', '--diff-filter=ACMR'], cwd);
  }
  const parts: string[] = [];
  for (const sha of fromCommits) {
    const r = runGit(
      ['diff-tree', '--no-commit-id', '-p', '--unified=0', '-r', '--diff-filter=ACMR', sha],
      cwd
    );
    if (r.kind === 'failed') return r;
    parts.push(r.stdout);
  }
  return { kind: 'ran', stdout: parts.join('\n') };
}

function report(findings: readonly Finding[], tail: string): number {
  if (findings.length === 0) {
    console.log(`oss-prose: PASS · exit ${EXIT_OK} · ${tail}, 0 deployment claim(s)`);
    return EXIT_OK;
  }
  for (const f of findings) {
    console.error(`  ${f.path}:${f.line}`);
    console.error(`      ${f.scope} + ${f.specific}`);
    console.error(`      ${f.sentence.slice(0, 200)}`);
  }
  console.error(
    `oss-prose: ADVISORY · exit ${EXIT_OK} · ${tail}, ${findings.length} deployment claim(s) in ${new Set(findings.map((f) => f.path)).size} file(s)`
  );
  console.error(
    '\n  NOT A REFUSAL, and there is no variable to set. Each sentence above is\n' +
      '  specific about our own running system and is bound for MGrin/scani-oss.\n' +
      '\n' +
      '  Decide per sentence. A measurement that motivated the change is usually\n' +
      '  worth keeping in ROUNDED or RELATIVE form — "a few hundred rows", "most of\n' +
      '  a night’s volume" — which explains the WHY without publishing the figure.\n' +
      '\n' +
      '  A DATABASE MIGRATION IS THE ONE THAT CANNOT BE UNDONE: `scripts/migrate.ts`\n' +
      '  refuses the whole run on sha256 drift, so an applied migration’s comment is\n' +
      '  permanent. Read those twice.\n' +
      '\n' +
      '  WHAT THIS CANNOT SEE: a named credential or an account label. Neither\n' +
      '  carries a measurement or a scope word (SC-909).\n' +
      '\n' +
      '  AND IT IS DEFEATED BY A REWORDING. It reads the vocabulary the claims\n' +
      '  that have been made are made of, so the same fact in other words passes\n' +
      '  it. A PASS IS NOT EVIDENCE THAT NO REAL FIGURE IS PUBLISHED (SC-1131).'
  );
  return EXIT_OK;
}

export function main(argv: readonly string[], cwd: string, stdin: string): number {
  const broken = selfTest();
  if (broken.length > 0) {
    for (const b of broken) console.error(`  ${b}`);
    console.error(
      `oss-prose: SELF-TEST FAILED · exit ${EXIT_SELF_TEST_FAILED} · ${broken.length} of ${SIGNAL_COUNT} signal(s) no longer behave as written — NOTHING WAS SCANNED`
    );
    return EXIT_SELF_TEST_FAILED;
  }

  // The audit mode reads the whole tree and answers a different question from
  // the hook: not *did this change add one* but *how many are already here*. It
  // is not wired into a hook precisely because those answers differ.
  if (argv.includes('--scan')) {
    const listed = runGit(['ls-files'], cwd);
    if (listed.kind === 'failed') {
      console.error(
        `oss-prose: UNKNOWN · exit ${EXIT_UNKNOWN} · could not list the tracked files to scan — ${listed.why} — NOTHING WAS SCANNED`
      );
      return EXIT_UNKNOWN;
    }
    const paths = listed.stdout.trim() === '' ? [] : listed.stdout.trim().split('\n');
    const findings: Finding[] = [];
    let sentences = 0;
    let scanned = 0;
    let unreadable = 0;
    for (const path of paths.filter(isScannable)) {
      let content: string;
      try {
        content = readFileSync(path, 'utf8');
      } catch {
        unreadable++;
        continue;
      }
      // A file with a NUL byte is not text; matching against it reports noise.
      if (content.includes('\0')) continue;
      scanned++;
      const r = findInContent(path, content);
      findings.push(...r.findings);
      sentences += r.sentences;
    }
    return report(
      findings,
      `${SIGNAL_COUNT} signal(s) self-tested, ${sentences} prose sentence(s) read across ${scanned} of ${paths.length} tracked file(s)${unreadable > 0 ? `, ${unreadable} UNREADABLE` : ''}`
    );
  }

  const scope = scanScope(collectBranchFacts(cwd, refArg(argv)), {
    privateMarkerPresent: existsSync('.private-repo'),
  } satisfies RepoFacts);
  if (scope.kind === 'unknown') {
    console.error(`oss-prose: UNKNOWN · exit ${EXIT_UNKNOWN} · ${scope.why}`);
    return EXIT_UNKNOWN;
  }
  // Read above the skip, because the skip has to say what it did not read
  // (SC-972). It is the same population the scan below uses — one function, so
  // the two lines cannot disagree about what was in the commit.
  const commits = argv.includes('--stdin-commits')
    ? stdin
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== '')
    : null;
  const noun = commits === null ? 'staged' : 'pushed';

  if (scope.kind === 'skip') {
    // SC-972. THE DIFF CLAUSE COMES FIRST AND THE BRANCH CLAUSE IS THE REASON,
    // the shape SC-835 settled on for the sibling that routes paths. A failed
    // read narrows this sentence and nothing else: the skip is a conclusion
    // about the branch, and it stays exit 0.
    const skipped = population(cwd, commits);
    const unread = skipped.kind === 'failed' ? null : countUnread(skipped.stdout, isScannable);
    console.log(
      `oss-prose: SKIPPED · exit ${EXIT_OK} · ${unreadClause(unread, noun)}` +
        ` · not bound for MGrin/scani-oss: ${scope.why}`
    );
    return EXIT_OK;
  }

  const diff = population(cwd, commits);
  if (diff.kind === 'failed') {
    console.error(
      `oss-prose: UNKNOWN · exit ${EXIT_UNKNOWN} · could not read the ${commits === null ? 'staged' : 'pushed'} changes — ${diff.why} — NOTHING WAS SCANNED`
    );
    return EXIT_UNKNOWN;
  }

  const added = addedLines(diff.stdout).filter((l) => isScannable(l.path));
  const { findings, sentences } = findInLines(added);

  // The denominator is printed on every outcome. `0 claim(s)` beside no count
  // at all is indistinguishable from a run that read nothing.
  const where =
    commits === null ? 'staged path(s)' : `path(s) in ${commits.length} pushed commit(s)`;
  return report(
    findings,
    `${SIGNAL_COUNT} signal(s) self-tested, ${sentences} prose sentence(s) read across ${new Set(added.map((l) => l.path)).size} ${where}`
  );
}

if (import.meta.main) {
  const stdin = process.argv.includes('--stdin-commits') ? await Bun.stdin.text() : '';
  process.exit(main(process.argv.slice(2), process.cwd(), stdin));
}
