export const normalizeSymbol = (s: string, max = 40): string =>
  s.trim().toUpperCase().slice(0, max);

export const normText = (s: string | undefined, max = 200): string | undefined =>
  typeof s === 'string' ? s.trim().slice(0, max) : undefined;

export const normalizeBalanceString = (s: string): string => s.trim();
