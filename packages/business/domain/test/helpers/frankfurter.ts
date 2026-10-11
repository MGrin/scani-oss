/** The latest table of each bank Scani asks, as the one client must request it. */
export const ECB_TABLE_URL = 'https://api.frankfurter.dev/v2/providers/ecb/rates?base=EUR';
export const CBR_TABLE_URL = 'https://api.frankfurter.dev/v2/providers/cbr/rates?base=USD';

/**
 * One fixing as Frankfurter v2 sends it: a row per quote, each naming its base
 * and its day. Each rate is units of the quote per one `base`.
 */
export function fixing(
  base: string,
  date: string,
  rates: Readonly<Record<string, unknown>>
): Array<{ date: string; base: string; quote: string; rate: unknown }> {
  return Object.entries(rates).map(([quote, rate]) => ({ date, base, quote, rate }));
}

/**
 * Every URL in `asked` that is not a named bank's table on Frankfurter v2:
 * exchangerate-api is gone, and v1 and the unnamed blend are never asked.
 */
export function outsideFrankfurterV2(asked: readonly string[]): string[] {
  return asked.filter(
    (url) =>
      !url.startsWith('https://api.frankfurter.dev/v2/providers/ecb/rates?') &&
      !url.startsWith('https://api.frankfurter.dev/v2/providers/cbr/rates?')
  );
}
