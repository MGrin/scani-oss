import type {
  ExportProvenanceDtoType,
  ExportSheetDtoType,
  ExportValueDtoType,
  TaxYearDisposals,
  TaxYearPdfLabels,
} from '@scani/shared';

interface Money {
  currency: string;
  symbolOf: (tokenId: string) => string;
}

const blank: ExportValueDtoType = { kind: 'blank' };
const text = (value: string): ExportValueDtoType => ({ kind: 'text', value });
const date = (value: string): ExportValueDtoType => ({ kind: 'date', value, withTime: false });
const quantity = (value: string): ExportValueDtoType => ({ kind: 'number', value });
const byDate =
  <T>(at: (row: T) => string) =>
  (a: T, b: T) =>
    at(a).localeCompare(at(b));

/** The calendar date an instant falls on in `timeZone`, as YYYY-MM-DD. */
function localDate(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at));
}

/**
 * SC-90's tax-year statement as the one sheet `renderStatement` draws, plus its
 * provenance block.
 *
 * No column is totalled. The engine sums a totalled column over the WHOLE
 * sheet, which would add airdrops into income; mgrin ruled on 2026-09-11 that
 * airdrops are listed and never totalled. The totals the statement does carry
 * are the ledger's own sums, placed in the provenance block with the method,
 * the zone, the generation time and the caveat the v1 ruling requires.
 */
export function taxYearDocument(
  result: TaxYearDisposals,
  labels: TaxYearPdfLabels,
  money: Money
): { sheet: ExportSheetDtoType; provenance: ExportProvenanceDtoType } {
  const cash = (value: string | null): ExportValueDtoType =>
    value === null
      ? blank
      : { kind: 'number', value, style: 'money', currency: money.currency, decimals: 2 };
  const asset = (tokenId: string) => text(money.symbolOf(tokenId));

  const disposals = [...result.rows]
    .sort(byDate((r) => r.disposedAt))
    .map((r) => [
      date(r.disposedAt),
      asset(r.tokenId),
      quantity(r.quantity),
      r.acquiredAt === null ? blank : date(r.acquiredAt),
      cash(r.proceeds),
      cash(r.costBasis),
      cash(r.gain),
      r.holdingDays === null ? blank : quantity(String(r.holdingDays)),
    ]);
  const incomeOf = (kind: 'interest' | 'reward' | 'airdrop') =>
    result.income.rows
      .filter((r) => r.kind === kind)
      .sort(byDate((r) => r.receivedAt))
      .map((r) => [
        date(r.receivedAt),
        asset(r.tokenId),
        quantity(r.quantity),
        blank,
        cash(r.value),
        blank,
        blank,
        blank,
      ]);
  const sections = [
    { label: labels.groups.disposals, rows: disposals },
    { label: labels.groups.interest, rows: incomeOf('interest') },
    { label: labels.groups.rewards, rows: incomeOf('reward') },
    { label: labels.groups.airdrops, rows: incomeOf('airdrop') },
  ];
  const h = labels.headers;
  const headers = [
    h.date,
    h.asset,
    h.quantity,
    h.acquired,
    h.amount,
    h.costBasis,
    h.gain,
    h.daysHeld,
  ];

  const sheet: ExportSheetDtoType = {
    name: labels.subject,
    headers,
    rows: sections.flatMap((s) => s.rows),
    numericColumns: [false, false, true, false, true, true, true, true],
    totalColumns: headers.map(() => false),
    groups: sections.map((s) => ({ label: s.label, rowCount: s.rows.length })),
  };

  const inCurrency = (value: string) => `${value} ${money.currency}`;
  const d = labels.details;
  const provenance: ExportProvenanceDtoType = {
    subject: labels.subject,
    // The last day is the one before the exclusive end, read in the year's own
    // zone, so a UK year prints 6 April to 5 April rather than two UTC instants.
    scope: `${localDate(Date.parse(result.periodStart), result.taxYear.timeZone)} – ${localDate(
      Date.parse(result.periodEnd) - 1,
      result.taxYear.timeZone
    )}`,
    generatedAt: result.generatedAt,
    rowCount: sheet.rows.length,
    details: [
      {
        label: d.year,
        value: `${result.taxYear.year} · ${labels.yearStarts[result.taxYear.yearStart]}`,
      },
      { label: d.method, value: labels.methods[result.costBasisMethod] },
      { label: d.timeZone, value: result.taxYear.timeZone },
      { label: d.gainTotal, value: inCurrency(result.totals.gain) },
      { label: d.interestTotal, value: inCurrency(result.income.totals.interest) },
      { label: d.rewardTotal, value: inCurrency(result.income.totals.reward) },
      { label: d.airdropNote, value: labels.airdropNote },
      {
        label: d.basisIncomplete,
        value: String(result.byBasisQuality.partial + result.byBasisQuality.unknown),
      },
      {
        label: d.awaitingReview,
        value: String(result.byOutcome.unreviewed + result.byOutcome.awaiting_pair),
      },
      {
        label: d.unvaluedIncome,
        value: String(
          result.income.unvalued.interest +
            result.income.unvalued.reward +
            result.income.unvalued.airdrop
        ),
      },
      { label: d.caveat, value: labels.caveat },
    ],
  };
  return { sheet, provenance };
}
