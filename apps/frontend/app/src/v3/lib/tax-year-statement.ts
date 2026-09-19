import type { TaxYearPdfLabels, TaxYearStart } from '@scani/shared';

/**
 * `year` is the calendar year the tax year STARTS in, which is what the server
 * takes. Any start other than 1 January runs into the next year, so it is shown
 * as the span people file it under.
 */
export function taxYearLabel(year: number, start: TaxYearStart): string {
  if (start === 'jan-1') return String(year);
  return `${year}–${String((year + 1) % 100).padStart(2, '0')}`;
}

export function recentTaxYears(now: Date, count = 6): number[] {
  const current = now.getFullYear();
  return Array.from({ length: count }, (_, i) => current - i);
}

/**
 * The PDF's words, in the reader's language. Words only — the server computes
 * every figure — and the caveat is required by the contract, so a statement
 * cannot be issued without it (Operator ruling, bus #12532).
 */
export function taxYearPdfLabels(t: (key: string) => string): TaxYearPdfLabels {
  const k = (key: string) => t(`v3.settings.taxYear.pdf.${key}`);
  return {
    subject: k('subject'),
    headers: {
      date: k('headers.date'),
      asset: k('headers.asset'),
      quantity: k('headers.quantity'),
      acquired: k('headers.acquired'),
      amount: k('headers.amount'),
      costBasis: k('headers.costBasis'),
      gain: k('headers.gain'),
      daysHeld: k('headers.daysHeld'),
    },
    groups: {
      disposals: k('groups.disposals'),
      interest: k('groups.interest'),
      rewards: k('groups.rewards'),
      airdrops: k('groups.airdrops'),
    },
    details: {
      year: k('details.year'),
      method: k('details.method'),
      timeZone: k('details.timeZone'),
      gainTotal: k('details.gainTotal'),
      interestTotal: k('details.interestTotal'),
      rewardTotal: k('details.rewardTotal'),
      airdropNote: k('details.airdropNote'),
      caveat: k('details.caveat'),
      basisIncomplete: k('details.basisIncomplete'),
      awaitingReview: k('details.awaitingReview'),
      unvaluedIncome: k('details.unvaluedIncome'),
    },
    methods: {
      fifo: t('v3.settings.costBasis.method.fifo'),
      uk_section_104: t('v3.settings.costBasis.method.uk_section_104'),
    },
    yearStarts: {
      'jan-1': t('v3.settings.taxYear.starts.jan-1'),
      'apr-1': t('v3.settings.taxYear.starts.apr-1'),
      'apr-6': t('v3.settings.taxYear.starts.apr-6'),
      'jul-1': t('v3.settings.taxYear.starts.jul-1'),
    },
    airdropNote: k('airdropNote'),
    caveat: t('v3.settings.taxYear.caveat'),
  };
}
