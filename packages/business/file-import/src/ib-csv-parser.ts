import type { ExtractedHolding, ParseResult } from './types';

/**
 * Parse an Interactive Brokers Activity Statement CSV.
 *
 * IB CSVs are NOT tabular — they're multi-section reports where each row
 * starts with: SectionName,RowType(Header|Data|Total|Notes),...fields
 *
 * We extract:
 * - Open Positions → stock/ETF holdings (symbol, quantity)
 * - Cash Report / Forex Balances → cash positions per currency
 */
export function parseIbCsvStatement(content: string): ParseResult {
  const warnings: string[] = [];
  const holdings: ExtractedHolding[] = [];

  const lines = content
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

  // Parse Open Positions section
  let positionHeaders: string[] = [];
  for (const line of lines) {
    const parts = parseCsvLine(line);
    if (parts.length < 3) continue;

    const section = parts[0];
    const rowType = parts[1];

    // Capture Open Positions header to know column indices
    if (section === 'Open Positions' && rowType === 'Header') {
      positionHeaders = parts;
      continue;
    }

    // Parse Open Positions data rows (only "Summary" rows, skip "Total")
    if (section === 'Open Positions' && rowType === 'Data' && positionHeaders.length > 0) {
      const dataDiscriminator = parts[2];
      // Only parse Summary rows (individual positions)
      if (dataDiscriminator !== 'Summary') continue;

      const symbolIdx = positionHeaders.indexOf('Symbol');
      const quantityIdx = positionHeaders.indexOf('Quantity');
      const currencyIdx = positionHeaders.indexOf('Currency');

      if (symbolIdx === -1 || quantityIdx === -1) {
        warnings.push('Open Positions: missing Symbol or Quantity column');
        continue;
      }

      const symbol = parts[symbolIdx];
      const quantityStr = parts[quantityIdx];
      const currency = currencyIdx !== -1 ? parts[currencyIdx] : undefined;

      if (!symbol || !quantityStr) continue;

      const quantity = Number(quantityStr.replace(/,/g, ''));
      if (Number.isNaN(quantity) || quantity === 0) continue;

      holdings.push({
        symbol: symbol!,
        balance: String(quantity),
        confidence: 1.0,
        notes: currency ? `${currency} position` : 'Stock position',
      });
    }

    // Parse Cash Report for ending cash balances per currency
    if (section === 'Cash Report' && rowType === 'Data') {
      const label = parts[2]; // e.g., "Starting Cash", "Ending Cash", etc.
      const currencySummary = parts[3]; // e.g., "Base Currency Summary", "USD", "CAD"

      if (
        label === 'Ending Cash' &&
        currencySummary &&
        currencySummary !== 'Base Currency Summary'
      ) {
        const totalIdx = 4; // "Total" column comes after currency
        const totalStr = parts[totalIdx];
        if (totalStr) {
          const balance = Number(totalStr.replace(/,/g, ''));
          if (!Number.isNaN(balance) && balance !== 0) {
            // Check if we already have this currency from Forex Balances
            const existing = holdings.find(
              (h) => h.symbol === currencySummary && h.notes?.includes('cash')
            );
            if (!existing) {
              holdings.push({
                symbol: currencySummary,
                balance: String(balance),
                confidence: 1.0,
                notes: `${currencySummary} cash balance`,
              });
            }
          }
        }
      }
    }
  }

  if (holdings.length === 0) {
    warnings.push('No positions or cash balances found in Interactive Brokers statement');
  }

  return {
    transactions: [],
    holdings,
    format: 'ib-csv',
    bankTemplate: 'interactive-brokers',
    warnings,
  };
}

/**
 * Parse a single CSV line, handling quoted fields with commas.
 */
function parseCsvLine(line: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;

    if (char === '"') {
      // Handle escaped quotes ("")
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current.trim());

  return parts;
}
