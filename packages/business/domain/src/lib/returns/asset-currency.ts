import { NON_US_EXCHANGE_SUFFIX_MAP } from '@scani/providers/core/utils/exchange-suffix';

/**
 * The currency an asset's own price is set in (SC-458).
 *
 * Splitting a return into what the asset did and what the exchange rate did
 * needs one thing the schema does not hold: the currency each asset is
 * QUOTED in. `tokens` has no such column, and adding one would be a
 * migration plus a backfill plus a per-provider write path — for a fact that
 * is already derivable from three columns this table does have.
 *
 * ## The rules, and why each one is defensible rather than convenient
 *
 * * **fiat → itself.** A GBP balance is worth exactly its own number of GBP
 *   forever. Every penny a GBP holder on a USD base "makes" is the exchange
 *   rate, and this is the case the whole ticket exists for.
 *
 * * **crypto → USD.** A modelling choice, stated out loud, not a fact about
 *   the token. Crypto's world price is quoted in USD — every venue, every
 *   provider we route through, every stablecoin peg — so a EUR-based holder
 *   of BTC really does carry EUR/USD between themselves and the market they
 *   are exposed to. It also makes a stablecoin come out right for free:
 *   USDC reads as 0% asset return and 100% currency return, which is what it
 *   is. The alternative — treating each coin as its own currency — makes the
 *   currency leg identically zero for every crypto holder and answers the
 *   question with a tautology.
 *
 * * **stock → its listing venue's currency**, from `market_segment` first and
 *   the symbol suffix second. Both are needed: production holds `XEQT` with
 *   `market_segment = 'TO'` and no suffix, AND `1796.HK` / `SPCX.TO` /
 *   `SPCX.VI` with a suffix and a NULL segment (measured 2026-08-20). Reading
 *   only the column calls a Hong Kong listing a dollar asset.
 *
 * * **A venue we do not recognise → unknown**, deliberately NOT USD. That is
 *   the case where guessing is most likely to be wrong and where a default
 *   would silently cover it, reporting a real currency movement as skill.
 *   Production has one today: `SPCX.VI` is Vienna, and `.VI` is absent from
 *   the shared suffix map (the Finnhub-local copy of that map has it; the two
 *   disagreeing is its own defect and not this ticket's to fix). A one-letter
 *   suffix is treated as a US share class instead — `BRK.A`, `BF.B` — which
 *   is what the suffix map itself deliberately omits them for.
 *
 * * **private-company / other → unknown.** Nothing in the row says what a
 *   hand-entered private valuation is denominated in.
 *
 * `market_segment` is read for `stock` ONLY. On crypto rows the same column
 * holds an EVM contract identity — 60 of production's 92 crypto tokens carry
 * `evm:1:0x…` there — so a shared reading of it would map an ERC-20 to
 * whatever currency its chain id happened to spell.
 */
export type AssetCurrency =
  /** The token IS the currency. Only fiat reaches this. */
  | { kind: 'self' }
  /** Quoted in this fiat currency, named by ISO symbol. */
  | { kind: 'fiat'; symbol: string }
  /** Nothing in the row says. The caller must not substitute a default. */
  | { kind: 'unknown' };

const US_SEGMENT = 'US';
const DEFAULT_EQUITY_CURRENCY = 'USD';
/** The currency crypto's world price is quoted in. See the note above. */
const CRYPTO_QUOTE_CURRENCY = 'USD';

export interface AssetCurrencyInput {
  typeCode: string | null;
  symbol: string;
  marketSegment: string | null;
}

export function assetCurrencyOf(token: AssetCurrencyInput): AssetCurrency {
  switch (token.typeCode) {
    case 'fiat':
      return { kind: 'self' };
    case 'crypto':
      return { kind: 'fiat', symbol: CRYPTO_QUOTE_CURRENCY };
    case 'stock':
      return equityCurrency(token);
    default:
      return { kind: 'unknown' };
  }
}

function equityCurrency(token: AssetCurrencyInput): AssetCurrency {
  const segment = token.marketSegment?.toUpperCase() ?? null;
  if (segment === US_SEGMENT) return { kind: 'fiat', symbol: DEFAULT_EQUITY_CURRENCY };
  if (segment) {
    const mapped = NON_US_EXCHANGE_SUFFIX_MAP[segment];
    if (mapped) return { kind: 'fiat', symbol: mapped.currency };
  }

  const suffix = suffixOf(token.symbol);
  if (suffix) {
    const mapped = NON_US_EXCHANGE_SUFFIX_MAP[suffix];
    if (mapped) return { kind: 'fiat', symbol: mapped.currency };
    // Two or more characters is a venue code we do not carry; one is a US
    // share class (`BRK.A`), which the suffix map omits on purpose so those
    // symbols stay routed to a US pricing provider.
    if (suffix.length > 1) return { kind: 'unknown' };
    return { kind: 'fiat', symbol: DEFAULT_EQUITY_CURRENCY };
  }

  // A segment we could not read is a venue we do not know; a segment that was
  // never set, on a symbol carrying no suffix, is the ordinary US listing
  // every enrichment path produces. The two must not collapse.
  return segment ? { kind: 'unknown' } : { kind: 'fiat', symbol: DEFAULT_EQUITY_CURRENCY };
}

function suffixOf(symbol: string): string | null {
  const dot = symbol.lastIndexOf('.');
  if (dot < 0 || dot === symbol.length - 1) return null;
  return symbol.slice(dot + 1).toUpperCase();
}
