import type { TFunction } from 'i18next';
import type { DataQualityKind, DataQualitySets } from './dataQuality';
import { holdingsQualityPath } from './routes';
/**
 * Settings' pure half — the two things on that screen that are derived rather
 * than typed in.
 *
 * Both live here for the same reason every other v3 `lib/` module does: they
 * are decisions about what a value *means*, they are the part a test can hold,
 * and neither needs a DOM to be wrong.
 */

/**
 * A cheap user-agent → "Browser on OS" summary, so a session row says something
 * a person can recognise their own laptop by.
 *
 * Six patterns rather than a UA-parsing dependency, which is v2's call and the
 * right one: the string is only ever shown to the account's own owner, next to
 * an IP and a last-seen time, and being wrong about Brave-reporting-as-Chrome
 * costs nothing that those two do not fix.
 *
 * Order matters in both ladders. Every Chromium browser also says "Safari", and
 * an iPad says "Mac OS X" in desktop mode, so the more specific token has to be
 * tested first or the answer is always the last one.
 */
export function summariseUserAgent(t: TFunction, userAgent: string | null): string {
  if (!userAgent) return t('v3.settings.device.unknown');
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Chrome\//.test(userAgent)
      ? 'Chrome'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : t('v3.settings.device.genericBrowser');
  const os = /iPhone|iPad/.test(userAgent)
    ? 'iOS'
    : /Android/.test(userAgent)
      ? 'Android'
      : /Mac OS X/.test(userAgent)
        ? 'macOS'
        : /Windows/.test(userAgent)
          ? 'Windows'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : t('v3.settings.device.unknownOs');
  // Browser and OS are PRODUCT names — Edge, macOS — so they are interpolated
  // rather than translated. Only the frame around them is copy.
  return t('v3.settings.device.browserOnOs', { browser, os });
}

/** The counters `portfolio.getDataQualityReport` returns, as this screen reads
 *  them. Narrower than the endpoint's own type on purpose — a counter added
 *  server-side should not have to be rendered before it type-checks. */
export interface DataQualityReport {
  /**
   * The holding ids behind each flagged counter (SC-293).
   *
   * Optional so an older API simply links nothing — and that fallback is the
   * safe one by construction, because a row is only ever a link when a
   * non-empty set arrives for it. The counters below stay on the type for the
   * same reason; when `flagged` is present they are its lengths, and when it
   * is absent they are all the screen has.
   */
  flagged?: DataQualitySets;
  duplicateTokens: readonly {
    symbol: string;
    count: number;
    /** The ASCII symbol a homoglyph presents as — `UЅDС` carries `USDC`
     *  (SC-197). Optional so an older API simply reports none. */
    lookalikeOf?: string | null;
  }[];
  /** Held tokens with no provider id the pricing router can route on (SC-217). */
  unroutableTokens?: readonly { symbol: string; segment: string | null }[];
  /** Held tokens whose symbol is drawn from lookalike characters (SC-271).
   *  Optional so an older API simply reports none. */
  lookalikeTokens?: readonly { symbol: string; lookalikeOf: string }[];
  holdings: {
    visible: number;
    total: number;
    zeroVisible: number;
    zeroVisibleStale: number;
    unpricedVisible: number;
    unpriceableVisible: number;
    negativeOpening: number;
    missingCoverage: number;
  };
  thresholds: { staleClosedDays: number };
}

export interface DataQualityRow {
  label: string;
  value: number;
  /** A number that is worth looking into, not merely non-zero. */
  warn: boolean;
  hint?: string;
  /**
   * Where the reader can see the positions behind the number (SC-293).
   *
   * Present only when the row is flagged AND the server named a non-empty set
   * for it. Both halves matter: an unflagged row is a fact rather than a
   * finding and needs no destination, and a row whose set the server did not
   * name has nowhere honest to go — which is exactly the state SC-268 found
   * every row in, and the state they must return to rather than acquire a
   * link that lands on an empty list.
   */
  href?: string;
}

const UNROUTABLE_SAMPLE = 5;

/**
 * Every duplicate symbol, as chips, with homoglyphs named (SC-270).
 *
 * **The list is complete on purpose.** It used to be `slice(0, 5)`, so a row
 * reading `6` sat above five chips with nothing saying any were omitted —
 * a count that disagrees with its own list, which is the class in
 * `docs/technical/2026-08-15_absence-and-refusal.md`. Any cap needs a
 * "+N more" to stay honest, that is new user-facing copy, and SC-202/SC-266
 * are mid-extraction in these files; showing all of them needs no copy and
 * makes the count and the list agree by construction. SC-200 made the row
 * wrap, so there is room for it.
 *
 * **A lookalike carries what it imitates.** `UЅDС` (Cyrillic Ѕ and С) is a
 * different string from `USDC`, so it never lands *inside* the real symbol's
 * group — it forms its own, and the two chips draw identically. Listing it
 * without saying so shows the reader two chips they cannot tell apart, which
 * is the hazard SC-197 exists for rather than a fix for it. The wording
 * matches the holdings badge (`v3.holdings.badge.lookalike`) so the same fact
 * reads the same way in both places.
 */
function duplicateChips(
  t: TFunction,
  tokens: DataQualityReport['duplicateTokens']
): string | undefined {
  if (tokens.length === 0) return undefined;
  return tokens
    .map((entry) =>
      entry.lookalikeOf
        ? // TWO NAMED VALUES, and in the case this row exists for they are the
          // same glyphs to look at — `USDC (displays as USDC)`, one of them
          // Cyrillic. i18next substitutes each placeholder independently, so
          // nothing collapses the pair; showing both IS the point.
          t('v3.settings.dataQuality.duplicateChipLookalike', {
            symbol: entry.symbol,
            count: entry.count,
            lookalikeOf: entry.lookalikeOf,
          })
        : t('v3.settings.dataQuality.duplicateChip', {
            symbol: entry.symbol,
            count: entry.count,
          })
    )
    .join(', ');
}

/**
 * The report as a list of rows, with the "is this bad" decision made once.
 *
 * The thresholds are the part worth having in a pure function: "zero-balance
 * visible holdings" is normal below a handful and a cluttered list above it,
 * while a single negative opening balance is always an import that did not
 * reach back far enough. v2 spells both out inline among the JSX, which is why
 * neither has ever been checked.
 *
 * **A row's number is the size of a set, and its link opens that set**
 * (SC-293). `count()` reads `flagged[kind].length` and falls back to the
 * standalone counter only for an API that predates the ids; `destination()`
 * hands back a path only when both halves hold — the row is flagged, and a
 * non-empty set arrived for it. Nothing here can produce a link to an empty
 * list, which is the one outcome SC-268 was protecting against.
 */
export function dataQualityRows(t: TFunction, report: DataQualityReport): DataQualityRow[] {
  const flagged = report.flagged;
  const sized = (kind: DataQualityKind): number | undefined => flagged?.[kind]?.length;
  const count = (kind: DataQualityKind, fallback: number): number => sized(kind) ?? fallback;
  const destination = (kind: DataQualityKind, warn: boolean): string | undefined =>
    warn && (sized(kind) ?? 0) > 0 ? holdingsQualityPath(kind) : undefined;

  // Optional on the type so a server-side counter does not have to be
  // rendered before the screen type-checks — an older API simply reports 0.
  const unroutable = report.unroutableTokens ?? [];
  const lookalikes = report.lookalikeTokens ?? [];

  const duplicates = count('duplicateSymbol', report.duplicateTokens.length);
  const lookalikeCount = count('lookalike', lookalikes.length);
  const unroutableCount = count('noPriceSource', unroutable.length);
  const zeroBalance = count('zeroBalance', report.holdings.zeroVisible);
  const noRecentPrice = count('noRecentPrice', report.holdings.unpricedVisible);
  const negativeOpening = count('negativeOpening', report.holdings.negativeOpening);
  const noCoverage = count('noCoverage', report.holdings.missingCoverage);

  return [
    {
      /**
       * Counted in POSITIONS, and scoped to the reader's own (SC-293).
       *
       * It used to count duplicate symbols across the whole `tokens`
       * catalogue: 11 in production against the 3 the reader actually holds,
       * including four symbols nobody holds at all. That number could not
       * become a link, because there was no list anywhere in the product it
       * was the length of — and a global catalogue fact is not something a
       * reader can act on in their own portfolio. What they CAN act on is a
       * position whose symbol they hold under more than one token row, which
       * is the case that silently splits one holding into two.
       */
      label: t('v3.settings.dataQuality.duplicateRows'),
      value: duplicates,
      warn: duplicates > 0,
      hint: duplicateChips(t, report.duplicateTokens),
      href: destination('duplicateSymbol', duplicates > 0),
    },
    {
      /**
       * Its own row rather than a widening of the one above (SC-271).
       *
       * That row counts duplicates, and the catalogue's `HAVING COUNT(*) > 1`
       * meant it could only ever reach a homoglyph that itself exists twice —
       * while an attacker airdropping an impersonating token sends ONE.
       * Folding lookalikes into it would also change what its number means,
       * and this panel has just been made honest about counts.
       *
       * Sits directly beneath because the two are the same question asked
       * twice: is a symbol on this screen not what it appears to be.
       */
      label: t('v3.settings.dataQuality.lookalikeRows'),
      value: lookalikeCount,
      warn: lookalikeCount > 0,
      hint:
        lookalikes.length > 0
          ? lookalikes
              .map((entry) =>
                t('v3.settings.dataQuality.lookalikeChip', {
                  symbol: entry.symbol,
                  lookalikeOf: entry.lookalikeOf,
                })
              )
              .join(', ')
          : undefined,
      href: destination('lookalike', lookalikeCount > 0),
    },
    {
      label: t('v3.settings.dataQuality.holdingsShown'),
      value: report.holdings.visible,
      warn: false,
      hint: t('v3.settings.dataQuality.holdingsShownHint', { count: report.holdings.total }),
    },
    {
      label: t('v3.settings.dataQuality.zeroBalanceShown'),
      value: zeroBalance,
      warn: zeroBalance > 5,
      href: destination('zeroBalance', zeroBalance > 5),
    },
    {
      label: t('v3.settings.dataQuality.hiddenNextSweep', {
        count: report.thresholds.staleClosedDays,
      }),
      value: report.holdings.zeroVisibleStale,
      warn: false,
    },
    {
      label: t('v3.settings.dataQuality.noRecentPrice'),
      value: noRecentPrice,
      warn: noRecentPrice > 0,
      href: destination('noRecentPrice', noRecentPrice > 0),
    },
    {
      // Sits directly under the row above because it is the same silence with
      // a different cause, and it WARNS where "nothing can price" deliberately
      // does not (SC-217). The distinction is whose fault the silence is:
      //
      //   "nothing can price"  — a claim about the ASSET. No market quotes
      //                          it. Nothing to fetch, nothing to fix.
      //   this row             — a claim about OUR CONFIGURATION. The token
      //                          carries no provider id, so the pricing
      //                          router has nothing to route on. It is
      //                          asked about and silently returns nothing,
      //                          every hour, forever.
      //
      // Both TRUMP rows were in this state and read as ordinary unpriced
      // positions for three months.
      //
      // The label no longer says "Of those" (SC-293). It is NOT a subset of
      // the row above: a token carrying no provider id is never quoted, so it
      // earns an unpriceable cooldown and leaves that row — which is exactly
      // the case this row exists for. The old wording also counted symbols
      // under a sentence about positions, so "0 of 9" could be read three
      // ways and was arithmetic in none of them.
      label: t('v3.settings.dataQuality.noPriceSource'),
      value: unroutableCount,
      warn: unroutableCount > 0,
      hint:
        unroutable.length > 0
          ? t('v3.settings.dataQuality.noPriceSourceHint', {
              symbols: unroutable
                .slice(0, UNROUTABLE_SAMPLE)
                .map((entry) => entry.symbol)
                .join(', '),
            })
          : undefined,
      href: destination('noPriceSource', unroutableCount > 0),
    },
    {
      // Never warns, and that is the point (SC-146). These are tokens no
      // market quotes — airdropped or delisted — so there is no price to
      // go and fetch and nothing here for the reader to fix. They are
      // listed because the net-worth chart leaves them out of its
      // coverage figure, and a number that quietly stops counting things
      // is its own defect.
      //
      // No link either, and for the same reason rather than for want of a
      // set: a row that is not a finding is not somewhere to be sent.
      label: t('v3.settings.dataQuality.nothingCanPrice'),
      value: report.holdings.unpriceableVisible,
      warn: false,
      hint: t('v3.settings.dataQuality.nothingCanPriceHint'),
    },
    {
      label: t('v3.settings.dataQuality.negativeOpening'),
      value: negativeOpening,
      warn: negativeOpening > 0,
      hint: t('v3.settings.dataQuality.negativeOpeningHint'),
      href: destination('negativeOpening', negativeOpening > 0),
    },
    {
      label: t('v3.settings.dataQuality.missingCoverage'),
      value: noCoverage,
      warn: noCoverage > 0,
      href: destination('noCoverage', noCoverage > 0),
    },
  ];
}
