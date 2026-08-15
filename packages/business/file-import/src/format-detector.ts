import type { StatementFormat } from './types';

/**
 * Detect bank statement file format from content and filename.
 */
export function detectFormat(content: string, filename?: string): StatementFormat | null {
  const ext = filename?.toLowerCase().split('.').pop();

  // Extension-based detection
  if (ext === 'ofx' || ext === 'qfx') return 'ofx';
  if (ext === 'sta' || ext === 'mt940') return 'mt940';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'qif') return 'qif';
  if (ext === 'csv' || ext === 'tsv') {
    // Check if this is an Interactive Brokers multi-section CSV
    if (isInteractiveBrokersCsv(content)) return 'ib-csv';
    return 'csv';
  }

  // Content-based detection
  const trimmed = content.trimStart();

  // OFX files start with OFXHEADER or <?OFX
  if (trimmed.startsWith('OFXHEADER') || trimmed.includes('<OFX>')) return 'ofx';

  // MT940 files start with :20: (Transaction Reference Number)
  if (/^:20:/.test(trimmed)) return 'mt940';

  // QIF files start with !Type:
  if (trimmed.startsWith('!Type:')) return 'qif';

  // IB CSV content-based detection
  if (isInteractiveBrokersCsv(trimmed)) return 'ib-csv';

  // Default to CSV if it looks like structured text with delimiters
  if (trimmed.includes(',') || trimmed.includes(';') || trimmed.includes('\t')) return 'csv';

  return null;
}

/**
 * Which template's own column names a file carries. One entry per
 * `BANK_TEMPLATES` key; every name here must be present for that template
 * to claim the file, so the list is the template's fingerprint rather than
 * a wish-list.
 */
const TEMPLATE_SIGNATURES: Record<string, string[]> = {
  revolut: ['Started Date', 'Description', 'Amount', 'Currency'],
  tinkoff: ['Дата операции', 'Описание', 'Сумма операции'],
  sberbank: ['Дата', 'Описание операции', 'Сумма'],
  alfabank: ['Дата операции', 'Назначение платежа', 'Сумма'],
  wise: ['Date', 'Description', 'Amount', 'Currency', 'Running Balance'],
  monzo: ['Transaction ID', 'Date', 'Name', 'Amount', 'Currency'],
};

/**
 * Which bank template a CSV header row belongs to, or null.
 *
 * A template must match its signature **in full**. The previous rule —
 * count the columns that are present, ignore the ones that are not, accept
 * anything scoring 3 — meant a header as ordinary as
 * `Date,Description,Amount,Currency,Balance` won the `wise` template on
 * four of five, and `wise` maps its balance to `Running Balance`, a column
 * that file does not have. Every row parsed with no balance, no closing
 * anchor was written, and the import created a **0-balance holding** while
 * reporting success (SC-137).
 *
 * Absence of a mismatch is not evidence of a match. Requiring the whole
 * signature makes a template hit mean "this really is that bank's export";
 * anything else falls through to `autoDetectMapping`, which reads column
 * names by pattern (including `Balance`) and gets these files right.
 */
export function detectBankTemplate(headerRow: string[]): string | null {
  const headers = new Set(headerRow.map((h) => h.trim()));

  let best: string | null = null;
  let bestSize = 0;
  for (const [template, signature] of Object.entries(TEMPLATE_SIGNATURES)) {
    if (!signature.every((column) => headers.has(column))) continue;
    // More columns matched = the more specific claim. `monzo` and `wise`
    // both fully match a Monzo export's header; the one naming five
    // columns beats a hypothetical four-column subset of itself.
    if (signature.length > bestSize) {
      best = template;
      bestSize = signature.length;
    }
  }

  return best;
}

/**
 * Detect Interactive Brokers multi-section CSV format.
 * IB CSVs start with "Statement,Header,Field Name,Field Value" and contain "Interactive Brokers".
 */
export function isInteractiveBrokersCsv(content: string): boolean {
  const firstLines = content.slice(0, 500);
  return (
    firstLines.includes('Statement,') &&
    firstLines.includes('BrokerName') &&
    firstLines.includes('Interactive Brokers')
  );
}
