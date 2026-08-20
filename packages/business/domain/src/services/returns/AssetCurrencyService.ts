import { Container, Service } from 'typedi';
import { assetCurrencyOf } from '../../lib/returns/asset-currency';
import { TokenRepository } from '../../repositories/TokenRepository';

/**
 * Which `tokens` row is the CURRENCY behind each asset (SC-458).
 *
 * `assetCurrencyOf` decides what an asset is quoted in and answers with an
 * ISO symbol; a rate lookup needs a token id. This is the bridge, and it is a
 * service rather than a helper because turning a symbol into an id is the one
 * step that touches the database — and doing it per holding is how a returns
 * request grows a second N+1 one ticket after the first was removed (SC-471).
 *
 * Two queries for any number of holdings: the tokens with their type codes,
 * and every active fiat token. The second is a whole-table read of 136 rows on
 * production — cheaper than the `IN (…)` it replaces, and it is narrowed to
 * `market_segment IS NULL` in memory because a symbol is not an identity here:
 * that is the same narrowing `findByIdentityTuple` performs, and the one that
 * keeps a memecoin called USD from beating the currency (SC-223).
 */
@Service()
export class AssetCurrencyService {
  private readonly tokenRepository = Container.get(TokenRepository);

  /**
   * `tokenId → currency token id`, with `null` for every token nothing could
   * place. A missing key means the token row itself was not found.
   *
   * `null` is a real answer and must reach the caller as one: substituting a
   * default currency would report a rate movement the reader is genuinely
   * exposed to as if it were performance.
   */
  async resolve(tokenIds: Iterable<string>): Promise<Map<string, string | null>> {
    const ids = [...new Set(tokenIds)];
    const resolved = new Map<string, string | null>();
    if (ids.length === 0) return resolved;

    const tokens = await this.tokenRepository.findManyWithTypes(ids);
    const decisions = tokens.map((token) => ({
      token,
      currency: assetCurrencyOf({
        typeCode: token.typeCode,
        symbol: token.symbol,
        marketSegment: token.marketSegment ?? null,
      }),
    }));

    const wantedSymbols = new Set(
      decisions.flatMap((entry) => (entry.currency.kind === 'fiat' ? [entry.currency.symbol] : []))
    );

    const bySymbol =
      wantedSymbols.size > 0 ? await this.fiatTokensBySymbol() : new Map<string, string>();

    for (const { token, currency } of decisions) {
      if (currency.kind === 'self') resolved.set(token.id, token.id);
      else if (currency.kind === 'unknown') resolved.set(token.id, null);
      else resolved.set(token.id, bySymbol.get(currency.symbol) ?? null);
    }
    return resolved;
  }

  private async fiatTokensBySymbol(): Promise<Map<string, string>> {
    const rows = await this.tokenRepository.findByType('fiat');
    const bySymbol = new Map<string, string>();
    for (const row of rows) {
      // The canonical currency row is the un-segmented one, by the same
      // constraint `PriceGraphService` resolves its hubs through. A segmented
      // fiat row is not a currency rates should be routed over.
      if (row.marketSegment !== null) continue;
      const symbol = row.symbol.toUpperCase();
      if (!bySymbol.has(symbol)) bySymbol.set(symbol, row.id);
    }
    return bySymbol;
  }
}
