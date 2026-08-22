import { attributeDecimals, type DecimalsAttribution, type DecimalsSource } from './tokens';

/**
 * SC-544 — the smallest indivisible unit of an L1 native asset, for the assets
 * where no contract exists to ask.
 *
 * `chain` cannot answer these. ADA, DOT, XRP, BTC, SOL and APT are not deployed
 * anywhere: their smallest unit is fixed by the protocol itself, the same way a
 * currency's minor unit is fixed by ISO 4217. That makes this the same KIND of
 * authority as `iso4217`, not a fourth one — a published constant rather than
 * an observation, which is why it is a table and not a fetch.
 *
 * WHY AN AGGREGATOR IS NOT AN OPTION HERE. CoinGecko's `decimal_place` is keyed
 * per DEPLOYMENT, not per asset: measured 2026-08-22, `starknet` answers 18, 18
 * and 9 across ethereum, starknet and solana, and `cardano`, `polkadot`,
 * `ripple` and `bitcoin` answer `null`. A single-valued column cannot take its
 * answer from a source that returns several or none.
 *
 * EVERY ENTRY CARRIES THE MEASUREMENT THAT ESTABLISHES IT, not a name to trust.
 * Each `citation` below is a command whose output a reader can compare against
 * `decimals` in one step, and every one of them was run on 2026-08-22 to
 * produce the value beside it. That is deliberate: a table of constants with no
 * way to check them is exactly the shape that put a guessed 18 on fourteen
 * equities in the first place.
 *
 * ONLY WHAT CAN BE CITED GOES IN. A token absent from this table stays NULL.
 * Extending it by inference — "BABY is probably 6 like other Cosmos assets" —
 * would reintroduce the guess this file exists to remove, one indirection
 * further away from the reader.
 *
 * KEYED ON THE COINGECKO ID rather than the symbol, because a symbol is not an
 * identity: production carries `SOL03` and `BABY` as Kraken asset codes, and
 * seven homoglyph impersonations of `USDC`/`USDT`. The CoinGecko id is the one
 * stable key already on these rows, and a row without one is a row we cannot
 * identify well enough to attribute a constant to.
 */

export interface ProtocolNativeDecimals {
  /** The exponent: one whole unit is `10^decimals` of the smallest unit. */
  readonly decimals: number;
  /** What the smallest unit is called, so the citation reads as a sentence. */
  readonly unit: string;
  /**
   * A command whose output establishes `decimals`, and what it returned when
   * it was run. Re-run it; if the arithmetic no longer lands, this entry is
   * wrong and should be removed rather than adjusted.
   */
  readonly citation: string;
}

export const PROTOCOL_NATIVE_DECIMALS: ReadonlyMap<string, ProtocolNativeDecimals> = new Map([
  [
    'bitcoin',
    {
      decimals: 8,
      unit: 'satoshi',
      citation:
        'curl -s https://blockchain.info/q/totalbc -> 2007151800000000 satoshi, which is 20,071,518 BTC at 10^8 (2026-08-22)',
    },
  ],
  [
    'cardano',
    {
      decimals: 6,
      unit: 'lovelace',
      citation:
        "curl -s 'https://api.koios.rest/api/v1/totals?_epoch_no=550' -> supply 37724696129606164 + reserves 7275303870393836 = 45000000000000000 lovelace, exactly Cardano's 45,000,000,000 ADA cap at 10^6 (2026-08-22)",
    },
  ],
  [
    'polkadot',
    {
      decimals: 10,
      unit: 'Planck',
      citation:
        'curl -s -X POST https://rpc.polkadot.io -d \'{"jsonrpc":"2.0","id":1,"method":"system_properties","params":[]}\' -> tokenDecimals 10 (2026-08-22)',
    },
  ],
  [
    'ripple',
    {
      decimals: 6,
      unit: 'drop',
      citation:
        'curl -s -X POST https://xrplcluster.com -d \'{"method":"server_state"}\' -> reserve_base 1000000 drops, while server_info reports the same reserve as reserve_base_xrp 1, so one XRP is 10^6 drops (2026-08-22)',
    },
  ],
  [
    'solana',
    {
      decimals: 9,
      unit: 'lamport',
      citation:
        'curl -s -X POST https://api.mainnet-beta.solana.com -d \'{"jsonrpc":"2.0","id":1,"method":"getTokenSupply","params":["So11111111111111111111111111111111111111112"]}\' -> decimals 9. That mint is wrapped SOL, 1:1 with SOL by construction (2026-08-22)',
    },
  ],
  [
    'aptos',
    {
      decimals: 8,
      unit: 'Octa',
      citation:
        "curl -s 'https://fullnode.mainnet.aptoslabs.com/v1/accounts/0x1/resource/0x1::coin::CoinInfo<0x1::aptos_coin::AptosCoin>' -> data.decimals 8 (2026-08-22)",
    },
  ],
]);

interface CoingeckoShape {
  coingecko?: { id?: unknown };
}

/**
 * The protocol constant for a token's metadata, or null when this table cannot
 * name one.
 *
 * Null is the ordinary answer and not a failure: every ERC-20 and every SPL
 * token gets its decimals from `chain`, and reaching this function at all means
 * the row had no contract to ask.
 */
export function protocolNativeDecimals(metadata: unknown): ProtocolNativeDecimals | null {
  const id = (metadata as CoingeckoShape | null | undefined)?.coingecko?.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  return PROTOCOL_NATIVE_DECIMALS.get(id) ?? null;
}

/**
 * The decimals to write for a token, and the authority behind it.
 *
 * One function so the INSERT path and the weekly identity sweep cannot drift:
 * a row created today and the same row re-examined on Sunday must reach the
 * same answer, or the sweep becomes a second opinion rather than a backfill.
 *
 * Order is deliberate. A value the caller was given always wins, because it
 * came from the asset's own chain and this table is a fallback for assets that
 * have no chain to ask. Only when nobody answered does the protocol constant
 * apply — so adding an entry here can never overwrite a contract's answer.
 */
export function resolveDecimals(
  supplied: number | null | undefined,
  suppliedSource: DecimalsSource | null | undefined,
  metadata: unknown
): DecimalsAttribution {
  const fromCaller = attributeDecimals(supplied, suppliedSource ?? 'chain');
  if (fromCaller.decimals !== null) return fromCaller;
  const constant = protocolNativeDecimals(metadata);
  return constant === null
    ? { decimals: null, decimalsSource: null }
    : attributeDecimals(constant.decimals, 'protocol');
}
