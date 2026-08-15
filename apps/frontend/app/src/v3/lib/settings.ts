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
export function summariseUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Chrome\//.test(userAgent)
      ? 'Chrome'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : 'Browser';
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
            : 'Unknown OS';
  return `${browser} on ${os}`;
}

/** The counters `portfolio.getDataQualityReport` returns, as this screen reads
 *  them. Narrower than the endpoint's own type on purpose — a counter added
 *  server-side should not have to be rendered before it type-checks. */
export interface DataQualityReport {
  duplicateTokens: readonly { symbol: string; count: number }[];
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
}

const DUPLICATE_SAMPLE = 5;

/**
 * The report as a list of rows, with the "is this bad" decision made once.
 *
 * The thresholds are the part worth having in a pure function: "zero-balance
 * visible holdings" is normal below a handful and a cluttered list above it,
 * while a single negative opening balance is always an import that did not
 * reach back far enough. v2 spells both out inline among the JSX, which is why
 * neither has ever been checked.
 */
export function dataQualityRows(report: DataQualityReport): DataQualityRow[] {
  const duplicates = report.duplicateTokens.length;
  return [
    {
      label: 'Duplicate token rows',
      value: duplicates,
      warn: duplicates > 0,
      hint:
        duplicates > 0
          ? report.duplicateTokens
              .slice(0, DUPLICATE_SAMPLE)
              .map((entry) => `${entry.symbol}×${entry.count}`)
              .join(', ')
          : undefined,
    },
    {
      label: 'Holdings shown',
      value: report.holdings.visible,
      warn: false,
      hint: `${report.holdings.total} in total`,
    },
    {
      label: 'Zero-balance holdings still shown',
      value: report.holdings.zeroVisible,
      warn: report.holdings.zeroVisible > 5,
    },
    {
      label: `Of those, hidden on the next ${report.thresholds.staleClosedDays}-day sweep`,
      value: report.holdings.zeroVisibleStale,
      warn: false,
    },
    {
      label: 'Shown positions with no recent price',
      value: report.holdings.unpricedVisible,
      warn: report.holdings.unpricedVisible > 0,
    },
    {
      // Never warns, and that is the point (SC-146). These are tokens no
      // market quotes — airdropped or delisted — so there is no price to
      // go and fetch and nothing here for the reader to fix. They are
      // listed because the net-worth chart leaves them out of its
      // coverage figure, and a number that quietly stops counting things
      // is its own defect.
      label: 'Shown positions nothing can price',
      value: report.holdings.unpriceableVisible,
      warn: false,
      hint: 'Airdropped or delisted tokens with no market — excluded from chart coverage',
    },
    {
      label: 'Negative synthesised opening balance',
      value: report.holdings.negativeOpening,
      warn: report.holdings.negativeOpening > 0,
      hint: 'An import that did not reach back before the first trade',
    },
    {
      label: 'Holdings with no coverage row',
      value: report.holdings.missingCoverage,
      warn: report.holdings.missingCoverage > 0,
    },
  ];
}
