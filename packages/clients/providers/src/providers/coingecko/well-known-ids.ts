/**
 * Symbol → CoinGecko slug map for tokens whose CoinGecko id can't be
 * derived from the lowercase symbol. CoinGecko uses long slugs
 * ("ethereum", "usd-coin") rather than tickers ("eth", "usdc"), so
 * symbol-only resolution gets it wrong for most majors.
 *
 * The map is small on purpose — it covers the high-traffic majors
 * we encounter constantly. Anything we don't know goes through the
 * `enrichTokenIdentity` flow which probes CoinGecko's `/coins/list`
 * once and writes the resolved id into `tokens.providerMetadata.coingecko.id`
 * for future calls.
 *
 * Pre-refactor location: `packages/pricing-providers/src/providers/coingecko.ts`.
 */

import type { TokenMetadata } from '@scani/db/schema';
import { CHAIN_ID_TO_COINGECKO_PLATFORM, COINGECKO_SOLANA_PLATFORM } from './chains';

export const WELL_KNOWN_COINGECKO_IDS: Record<string, string> = {
  eth: 'ethereum',
  btc: 'bitcoin',
  matic: 'matic-network',
  pol: 'polygon-ecosystem-token',
  usdc: 'usd-coin',
  usdt: 'tether',
  bnb: 'binancecoin',
  sol: 'solana',
  avax: 'avalanche-2',
  ada: 'cardano',
  dot: 'polkadot',
  doge: 'dogecoin',
  shib: 'shiba-inu',
  link: 'chainlink',
  uni: 'uniswap',
  xrp: 'ripple',
  ltc: 'litecoin',
  atom: 'cosmos',
  near: 'near',
  steth: 'staked-ether',
  weth: 'weth',
  dai: 'dai',
  trx: 'tron',
  ton: 'the-open-network',
  apt: 'aptos',
  fil: 'filecoin',
  xlm: 'stellar',
  etc: 'ethereum-classic',
  bch: 'bitcoin-cash',
};

/**
 * Where a token actually lives on-chain: a CoinGecko asset-platform id
 * plus the contract address (or Solana mint) on it.
 *
 * `null` is a first-class value and means "this row has no contract" —
 * fiat, exchange catalogue entries, equities, and native assets like
 * ETH or BTC. Those rows are resolved by symbol exactly as before.
 */
export type ContractRef = { platform: string; address: string };

/**
 * Canonical on-chain deployments of the well-known ids above, as
 * CoinGecko itself reports them (`/coins/list?include_platform=true`),
 * scoped to the platforms in `./chains.ts` — those are the only ones a
 * scani provider can produce a contract for.
 *
 * This table exists to answer one question: *does the address we were
 * handed contradict the id the symbol suggested?* An id is refused only
 * on a POSITIVE contradiction — CoinGecko places the asset on that
 * platform at address X and we hold Y. Absence is not contradiction:
 * `weth` lists only its Ethereum deployment, so WETH on Base
 * (`l2-standard-bridged-weth-base` to CoinGecko) resolves as before and
 * keeps its DeFiLlama-sourced prices, and `matic-network` lists no
 * deployment at all so real MATIC keeps pricing. Measured against
 * production 2026-08-18: strict absence-denial would have blanked three
 * genuinely-held rows, positive-contradiction denial blanks none.
 */
export const WELL_KNOWN_COINGECKO_DEPLOYMENTS: Record<string, Record<string, string>> = {
  // `0x…1010` is POL's predeploy on Polygon PoS — a real contract that
  // merely looks null-ish. A guard that treats leading zeros as "no
  // address" refuses the one deployment most POL holders actually have.
  'polygon-ecosystem-token': {
    ethereum: '0x455e53cbb86018ac2b8092fdcd39d8444affc3f6',
    'polygon-pos': '0x0000000000000000000000000000000000001010',
  },
  'usd-coin': {
    'arbitrum-one': '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    avalanche: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
    base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    celo: '0xceba9300f2b948710d2653dd7b07f33a8b32118c',
    cronos: '0x3d7f2c478aafdb65542bcb44bceec05849999d2d',
    ethereum: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    'optimistic-ethereum': '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
    'polygon-pos': '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
    solana: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    zksync: '0x1d17cbcf0d6d143135ae902365d2e5e2a16538d4',
  },
  tether: {
    avalanche: '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7',
    celo: '0x48065fbbe25f71c9282ddf5e1cd6d6a887483d5e',
    ethereum: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    solana: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  },
  binancecoin: {
    ethereum: '0xb8c77482e45f1f44de1745f52c74426c631bdd52',
  },
  'shiba-inu': {
    ethereum: '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce',
  },
  chainlink: {
    'arbitrum-one': '0xf97f4df75117a78c1a5a0dbb814af92458539fb4',
    avalanche: '0x5947bb275c521040051d82396192181b413227a3',
    base: '0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196',
    'binance-smart-chain': '0xf8a0bf9cf54bb92f17374d9e9a321e6a111a51bd',
    blast: '0x93202ec683288a9ea75bb829c6bacfb2bfea9013',
    celo: '0xd07294e6e917e07dfdcee882dd1e2565085c2ae0',
    cronos: '0x8c80a01f461f297df7f9da3a4f740d7297c8ac85',
    ethereum: '0x514910771af9ca656af840dff83e8264ecf986ca',
    fantom: '0xb3654dc3d10ea7645f8319668e8f54d2574fbdc8',
    linea: '0xa18152629128738a5c081eb226335fed4b9c95e9',
    mantle: '0xfe36cf0b43aae49fbc5cfc5c0af22a623114e043',
    moonbeam: '0x012414a392f9fa442a3109f1320c439c45518ac3',
    moonriver: '0x8b12ac23bfe11cab03a634c1f117d64a7f2cfd3e',
    opbnb: '0x99f0d88b81b758ab07e22c7aba00e0121a882dea',
    'optimistic-ethereum': '0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6',
    'polygon-pos': '0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39',
    scroll: '0x548c6944cba02b9d1c0570102c89de64d258d3ac',
    solana: 'LinkhB3afbBKb2EQQu7s7umdZceV3wcvAUJhQAfQ23L',
    xdai: '0xe2e73a1c69ecf83f464efce6a5be353a37ca09b2',
    zksync: '0x52869bae3e091e36b0915941577f2d47d8d8b534',
  },
  uniswap: {
    'arbitrum-one': '0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0',
    avalanche: '0x8ebaf22b6f053dffeaf46f4dd9efa95d89ba8580',
    'binance-smart-chain': '0xbf5140a22578168fd562dccf235e5d43a02ce9b1',
    ethereum: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
    'optimistic-ethereum': '0x6fd9d7ad17242c41f7131d257212c54a0e816691',
    'polygon-pos': '0xb33eaad8d922b1083446dc23f610c2567fb5180f',
    xdai: '0x4537e328bf7e4efa29d05caea260d7fe26af9d74',
  },
  cosmos: {
    'binance-smart-chain': '0x0eb3a705fc54725037cc9e008bdede697f62f335',
  },
  'staked-ether': {
    ethereum: '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
  },
  weth: {
    ethereum: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  },
  dai: {
    ethereum: '0x6b175474e89094c44da98b954eedeac495271d0f',
  },
  'the-open-network': {
    'binance-smart-chain': '0x76a797a59ba2c17726896976b7b3747bfd1d220f',
    ethereum: '0x582d872a1b094fc48f5de31d3b73f2d9be47def1',
  },
};

/**
 * EVM addresses are case-insensitive hex; Solana mints are base58 and
 * case-carrying, so lowercasing one would compare two different mints
 * equal.
 */
function normalizeAddress(platform: string, address: string): string {
  return platform === COINGECKO_SOLANA_PLATFORM ? address : address.toLowerCase();
}

/** Where the token this metadata describes lives, if anywhere. */
export function contractRefFromMetadata(
  metadata: TokenMetadata | null | undefined
): ContractRef | null {
  const evm = metadata?.etherscan;
  if (evm?.contractAddress) {
    const platform = CHAIN_ID_TO_COINGECKO_PLATFORM[evm.chainId];
    if (platform) return { platform, address: evm.contractAddress.toLowerCase() };
  }
  const mint = metadata?.solana?.mint;
  if (mint) return { platform: COINGECKO_SOLANA_PLATFORM, address: mint };
  return null;
}

/**
 * The ids {@link WELL_KNOWN_COINGECKO_IDS} can produce from a symbol
 * alone. Membership is what earns a row the stricter bar in
 * {@link resolveCoingeckoId} — see that function's docblock for why.
 *
 * Derived rather than written out: a hand-maintained second copy would
 * drift from the map the moment either changed, and the failure would be
 * silent in the direction that matters (an id quietly dropping out of the
 * set stops being guarded).
 */
const WELL_KNOWN_TARGET_IDS: ReadonlySet<string> = new Set(Object.values(WELL_KNOWN_COINGECKO_IDS));

/**
 * True when `deployments` places the asset on the contract's platform at
 * exactly the address we hold — the positive form of
 * {@link contradictsDeployments}, not its negation. Silence is a `false`
 * here and a `false` there, which is the whole difference between the two
 * rules.
 */
function matchesDeployments(
  deployments: Record<string, string | null | undefined> | undefined,
  contract: ContractRef
): boolean {
  const canonical = deployments?.[contract.platform];
  if (!canonical) return false;
  return (
    normalizeAddress(contract.platform, canonical) ===
    normalizeAddress(contract.platform, contract.address)
  );
}

/**
 * True when `deployments` places the asset on the contract's platform at
 * a *different* address than the one we hold — i.e. the address says the
 * id is wrong. Silence (no entry for that platform, or no deployments at
 * all) is not a contradiction; see the table's docblock.
 */
export function contradictsDeployments(
  deployments: Record<string, string | null | undefined> | undefined,
  contract: ContractRef
): boolean {
  const canonical = deployments?.[contract.platform];
  if (!canonical) return false;
  return (
    normalizeAddress(contract.platform, canonical) !==
    normalizeAddress(contract.platform, contract.address)
  );
}

/**
 * Resolve a CoinGecko id from either the metadata or the symbol, and
 * refuse it when the token's own contract address does not support it.
 *
 * `contract` is deliberately required rather than optional: the defect
 * this guard closes (SC-389) was a symbol-derived id being stamped onto
 * a row whose contract address was sitting right there unread, so a call
 * site that forgets to supply it must fail to compile. Pass `null` only
 * when the row genuinely has no contract.
 *
 * The check covers a stored `metadataId` as well as the symbol fallback,
 * because a poisoned id already written to `providerMetadata` prices the
 * row on every subsequent run — stripping the metadata alone would not
 * stop it.
 *
 * ## Two bars, and why they differ (SC-390)
 *
 * For an arbitrary id the bar is POSITIVE CONTRADICTION: refuse only when
 * CoinGecko places that id on this platform at a different address.
 * Absence is admitted, because absence is where the legitimate rows live
 * — CoinGecko files bridged WETH under its own id, so `weth` records no
 * Base deployment at all. SC-389 measured absence-denial and rejected it.
 *
 * For an id in {@link WELL_KNOWN_TARGET_IDS} the bar is a POSITIVE MATCH:
 * the contract must be one of that id's recorded deployments. These 29
 * ids are reachable from a symbol alone, which makes them exactly the
 * impersonation targets — the only ids an attacker can aim at by naming a
 * contract `USDT`. They can therefore carry a higher bar than an id that
 * had to be earned from `/coins/list`.
 *
 * The gap this closes: a row is stamped with a well-known id, the
 * contract sits on a chain CoinGecko lists no deployment for, and there
 * is nothing to contradict — only silence. Production held `TRX` at
 * `base:0x32fa6384…` carrying `{"id":"tron"}` that way, and `canPrice`
 * returned true for it, so the next pricing run would have written TRON's
 * price onto it exactly as the deleted `USDT` row collected Tether's.
 *
 * Measured against production 2026-08-18 (245 token rows, read-only), the
 * stricter bar newly denies exactly two rows and neither loses a price:
 *
 *   MATIC `ethereum:0x7d1afa7b…` — `matic-network` records no platform
 *     contracts at all, so a CORRECT id is refused here. That is the real
 *     cost of this rule and it was checked end to end rather than assumed:
 *     DeFiLlama answers for that contract today (0.0820, confidence 0.99)
 *     and covers all 47 days CoinGecko uniquely holds, plus 687 CoinGecko
 *     never had. The router's CoinGecko→DeFiLlama fallback fires on the
 *     `_no_data` row a refused id produces, and the historical backfill
 *     walks past a provider that returns zero quotes. Existing rows are
 *     retained; only future writes move.
 *   WETH `base:0x4200…0006` — 0 CoinGecko prices ever, 1854 DeFiLlama,
 *     priced hourly by DeFiLlama today. Zero cost.
 *
 * The standing risk is the mirror of the benefit: under a positive match,
 * a STALE {@link WELL_KNOWN_COINGECKO_DEPLOYMENTS} refuses a legitimate
 * row rather than merely failing to catch a bad one. The table was
 * verified exact against CoinGecko's catalogue when this shipped — 51
 * `(id, platform)` pairs across 12 ids, 0 missing, 0 mismatched — and the
 * blast radius is bounded by the same DeFiLlama fallback measured above.
 *
 * ## Why this is not in `@scani/db`'s `token-identity-authority.ts`
 *
 * That module answers which identity NAMESPACE on a row outranks another
 * (`foreign-native` vs `evm-contract`) and is deliberately in `@scani/db`
 * so every caller can reach it. This rule is a different question —
 * whether CoinGecko's own catalogue supports an id — and it reads two
 * CoinGecko tables that belong to `@scani/providers`. Moving it down
 * would invert the dependency direction (`providers` → `db`, never the
 * reverse) and file CoinGecko catalogue knowledge under the schema. It
 * stays here, at the one chokepoint SC-389 established, and reuses that
 * vocabulary rather than starting a third.
 */
export function resolveCoingeckoId(opts: {
  metadataId?: string | undefined;
  symbol: string;
  contract: ContractRef | null;
}): string | null {
  const id = opts.metadataId ?? WELL_KNOWN_COINGECKO_IDS[opts.symbol.toLowerCase()] ?? null;
  if (!id || !opts.contract) return id;
  const deployments = WELL_KNOWN_COINGECKO_DEPLOYMENTS[id];
  if (WELL_KNOWN_TARGET_IDS.has(id)) {
    return matchesDeployments(deployments, opts.contract) ? id : null;
  }
  return contradictsDeployments(deployments, opts.contract) ? null : id;
}
