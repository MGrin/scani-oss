import type { HoldingWithDetails } from '@scani/shared';

export function exportHoldingsData(holdings: HoldingWithDetails[], format: 'csv' | 'json') {
  const data = holdings.map((h) => ({
    Institution: h.institution.name,
    Account: h.account.name,
    Token: h.token.name,
    Symbol: h.token.symbol,
    Type: h.token.type,
    Amount: h.amount,
    Value: h.value,
  }));

  if (format === 'csv') {
    if (data.length === 0 || !data[0]) return;
    const headers = Object.keys(data[0]).join(',');
    const rows = data.map((row) =>
      Object.values(row)
        .map((val) => `"${val}"`)
        .join(',')
    );
    const csv = [headers, ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'holdings.csv';
    a.click();
    URL.revokeObjectURL(url);
  } else {
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'holdings.json';
    a.click();
    URL.revokeObjectURL(url);
  }
}
