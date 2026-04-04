import type { StatementFormat } from './types';

/**
 * Detect bank statement file format from content and filename.
 */
export function detectFormat(content: string, filename?: string): StatementFormat | null {
  const ext = filename?.toLowerCase().split('.').pop();

  // Extension-based detection
  if (ext === 'ofx' || ext === 'qfx') return 'ofx';
  if (ext === 'sta' || ext === 'mt940') return 'mt940';
  if (ext === 'csv' || ext === 'tsv') return 'csv';

  // Content-based detection
  const trimmed = content.trimStart();

  // OFX files start with OFXHEADER or <?OFX
  if (trimmed.startsWith('OFXHEADER') || trimmed.includes('<OFX>')) return 'ofx';

  // MT940 files start with :20: (Transaction Reference Number)
  if (/^:20:/.test(trimmed)) return 'mt940';

  // Default to CSV if it looks like structured text with delimiters
  if (trimmed.includes(',') || trimmed.includes(';') || trimmed.includes('\t')) return 'csv';

  return null;
}

/**
 * Try to auto-detect which bank template matches a CSV header row.
 */
export function detectBankTemplate(headerRow: string[]): string | null {
  const headers = new Set(headerRow.map((h) => h.trim()));

  // Check each template's required columns against the headers
  const templateScores: [string, number][] = [
    ['revolut', matchScore(headers, ['Started Date', 'Description', 'Amount', 'Currency'])],
    ['tinkoff', matchScore(headers, ['Дата операции', 'Описание', 'Сумма операции'])],
    ['sberbank', matchScore(headers, ['Дата', 'Описание операции', 'Сумма'])],
    ['alfabank', matchScore(headers, ['Дата операции', 'Назначение платежа', 'Сумма'])],
    ['wise', matchScore(headers, ['Date', 'Description', 'Amount', 'Currency', 'Running Balance'])],
  ];

  const best = templateScores.sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] >= 3) return best[0]!;

  return null;
}

function matchScore(headers: Set<string>, required: string[]): number {
  return required.filter((r) => headers.has(r)).length;
}
