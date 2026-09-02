/**
 * WHO THE DEMO IS ABOUT — the one place the invented person is described.
 *
 * Ivy Calder is fictional and every figure attached to her is invented. No row
 * in this file, and nothing derived from it, comes from a real account: not a
 * scrubbed copy, not a subset, not a rescaled one. The only thing borrowed
 * from reality is the *shape* of a price series, and even those start at a
 * chosen number and walk from a seed.
 *
 * She is the reader SC-450's funnel says we are failing to reach: a UK-resident
 * independent consultant whose money is spread across five jurisdictions'
 * worth of institutions and three currencies, which is the state that makes a
 * portfolio tracker worth opening and a spreadsheet stop working.
 *
 * - **Income in EUR.** Two EU clients on monthly retainers, landing in a Wise
 *   EUR balance.
 * - **Living costs in GBP.** Rent, broadband, mobile, an accountant, an annual
 *   indemnity premium — the recurring side of Money.
 * - **Investments in USD.** A brokerage account at Interactive Brokers holding
 *   four US-listed positions, so every gain on the holdings page is two
 *   movements at once: the asset's, and the dollar's against her base currency.
 * - **Crypto across three chains plus an exchange.** Kraken as the on-ramp,
 *   with self-custody on Ethereum, Bitcoin and Solana — which is what puts
 *   real transfers in the review queue rather than invented ones.
 * - **Base currency GBP, cost basis `uk_section_104`.** SC-462 names the UK
 *   taxpayer as the primary user and pooling as the rule that applies to them;
 *   a demo whose realized figures were FIFO would be showing the wrong number
 *   to the person it is aimed at.
 */

import type { CostBasisMethodDto } from '@scani/shared';

export const DEMO_USER_EMAIL = 'ivy.calder@demo.scani.xyz';
export const DEMO_USER_NAME = 'Ivy Calder';
export const DEMO_BASE_CURRENCY = 'GBP';
export const DEMO_COST_BASIS_METHOD: CostBasisMethodDto = 'uk_section_104';
export const DEMO_TIMEZONE = 'Europe/London';

/**
 * The last day the dataset has anything to say about, and the instant every
 * relative date in it is measured back from.
 *
 * **Fixed, not `new Date()`, and that is the whole determinism requirement.**
 * A dataset dated from the calendar produces different figures every day it is
 * reseeded, which defeats a committed screenshot and a visual baseline alike —
 * SC-473 hit exactly this from the other side and could not photograph a hero
 * chart with a curve in it.
 *
 * This particular day is not arbitrary: `FIXED_NOW` in
 * `apps/e2e/visual/v3-screens.spec.ts` pins the visual harness's client clock
 * to `2027-03-04T09:15:00Z`, and the home hero windows its series off that
 * clock. Anchoring here means a window asked for at the pinned instant lands
 * *inside* the seeded history instead of ahead of it. Nothing enforces the
 * pairing yet, because nothing consumes this dataset yet — the visual gate
 * still uses its own seeded fixture and SC-473's four baselines depend on that
 * one staying exactly as it is.
 *
 * A caller that wants the dataset to sit against the real calendar instead —
 * a live demo deployment, where a chart ending in the future reads as broken —
 * passes its own anchor. Determinism is preserved either way: same anchor,
 * same figures.
 */
export const DEMO_ANCHOR_DATE = '2027-03-04';

/** Roughly 18 months, inclusive of the anchor day. */
export const DEMO_HISTORY_DAYS = 549;

export interface AssetSpec {
  readonly symbol: string;
  readonly name: string;
  readonly typeCode: 'crypto' | 'stock';
  readonly decimals: number;
  /** `'US'` for the US-listed equities; null for crypto. */
  readonly marketSegment: string | null;
  /** Price in USD on the first day of the window. */
  readonly startPrice: number;
  /** Fraction the trend grows across the whole window. */
  readonly totalDrift: number;
  readonly volatility: number;
  /** Decimal places prices are rounded to. */
  readonly priceDecimals: number;
}

/**
 * Everything the demo holds that is not a currency, quoted in USD.
 *
 * Priced in USD rather than in the base currency deliberately: a position
 * whose native quote is the base is a position with no FX in it, and FX
 * attribution (SC-458) is one of the things this dataset exists to have
 * something to show.
 */
export const DEMO_ASSETS: readonly AssetSpec[] = [
  {
    symbol: 'VOO',
    name: 'Vanguard S&P 500 ETF',
    typeCode: 'stock',
    decimals: 4,
    marketSegment: 'US',
    startPrice: 402.15,
    totalDrift: 0.21,
    volatility: 0.009,
    priceDecimals: 2,
  },
  {
    symbol: 'AAPL',
    name: 'Apple Inc.',
    typeCode: 'stock',
    decimals: 4,
    marketSegment: 'US',
    startPrice: 178.4,
    totalDrift: 0.27,
    volatility: 0.013,
    priceDecimals: 2,
  },
  {
    symbol: 'MSFT',
    name: 'Microsoft Corporation',
    typeCode: 'stock',
    decimals: 4,
    marketSegment: 'US',
    startPrice: 339.8,
    totalDrift: 0.31,
    volatility: 0.012,
    priceDecimals: 2,
  },
  {
    symbol: 'NVDA',
    name: 'NVIDIA Corporation',
    typeCode: 'stock',
    decimals: 4,
    marketSegment: 'US',
    startPrice: 46.2,
    totalDrift: 1.45,
    volatility: 0.026,
    priceDecimals: 2,
  },
  {
    symbol: 'BTC',
    name: 'Bitcoin',
    typeCode: 'crypto',
    decimals: 8,
    marketSegment: null,
    startPrice: 27_480,
    totalDrift: 1.18,
    volatility: 0.028,
    priceDecimals: 2,
  },
  {
    symbol: 'ETH',
    name: 'Ethereum',
    typeCode: 'crypto',
    decimals: 8,
    marketSegment: null,
    startPrice: 1682,
    totalDrift: 0.62,
    volatility: 0.031,
    priceDecimals: 2,
  },
  {
    symbol: 'SOL',
    name: 'Solana',
    typeCode: 'crypto',
    decimals: 6,
    marketSegment: null,
    startPrice: 21.4,
    totalDrift: 2.35,
    volatility: 0.042,
    priceDecimals: 2,
  },
  {
    symbol: 'USDC',
    name: 'USD Coin',
    typeCode: 'crypto',
    decimals: 6,
    marketSegment: null,
    startPrice: 1,
    totalDrift: 0,
    volatility: 0.0004,
    priceDecimals: 4,
  },
];

/**
 * The two forex legs, quoted the way `forex-backfill` quotes them — the price
 * of one unit of the named currency *in USD*, because every hub edge in
 * `PRICE_HUBS` is anchored on USD (see `forex-backfill.ts`, which calls
 * `backfillOne(tokenId, at, usdTokenId)`). Seeding them the other way round
 * would still resolve, by inversion, and would be a lie about where the rows
 * came from.
 */
export interface ForexSpec {
  readonly symbol: string;
  readonly startPrice: number;
  readonly totalDrift: number;
  readonly volatility: number;
}

export const DEMO_FOREX: readonly ForexSpec[] = [
  { symbol: 'GBP', startPrice: 1.2465, totalDrift: 0.023, volatility: 0.004 },
  { symbol: 'EUR', startPrice: 1.0855, totalDrift: -0.018, volatility: 0.004 },
];

/**
 * THE ONE EDGE THAT IS NOT QUOTED IN USD, and it is here because seeding only
 * the convention above renders a USD cash holding as **unpriceable** for a
 * GBP-base user.
 *
 * `forex-backfill` never writes a row whose `token_id` is USD — every edge it
 * fetches is `X -> USD`. `PriceGraphService` copes: it inverts the `GBP -> USD`
 * row and answers `USD -> GBP` correctly, measured at rate 0.789266 against
 * this very seed. But `HoldingQueryService` does not value a holding through
 * the graph; it reads a per-symbol price map built upstream, and a token with
 * no `token_prices` row of its own is absent from it. The row then renders
 * with a null value and a -100% gain against a real cost basis.
 *
 * Which is to say: a real GBP-base account holding USD cash probably shows the
 * same blank today. That is worth a ticket and is not this one — the dataset's
 * job is to be correct, so it writes the reciprocal row and says why.
 */
export const DEMO_BASE_QUOTED_FOREX = 'USD';

export interface InstitutionSpec {
  readonly name: string;
  readonly typeCode: string;
}

/**
 * Every institution here already exists in `0000_clean_start.sql`'s public
 * catalog. The seeder looks each one up by name and only inserts when it is
 * genuinely absent, because `institutions` is shared by every user in the
 * database and a demo that forks the catalog leaves a second "Kraken" behind
 * for everyone.
 */
export const DEMO_INSTITUTIONS: readonly InstitutionSpec[] = [
  { name: 'Wise', typeCode: 'other' },
  { name: 'Revolut', typeCode: 'other' },
  { name: 'Interactive Brokers', typeCode: 'broker' },
  { name: 'Kraken', typeCode: 'crypto_exchange' },
  { name: 'Ethereum', typeCode: 'crypto_wallet' },
  { name: 'Bitcoin', typeCode: 'crypto_wallet' },
  { name: 'Solana', typeCode: 'crypto_wallet' },
];

export interface AccountSpec {
  /** Stable key used to derive the account's uuid and to link holdings. */
  readonly key: string;
  readonly institution: string;
  readonly name: string;
  /** One of the `account_types` codes seeded by migration 0000. */
  readonly typeCode: 'checking' | 'savings' | 'investment' | 'crypto' | 'other';
  readonly description: string;
  /**
   * Present on the three self-custody wallets, and the whole of what
   * `accounts.metadata` is built from for them.
   *
   * Grouped rather than two sibling optionals because every consumer treats a
   * null `chainId` as "not a wallet" and says nothing — so a spec carrying an
   * address without a chain would seed exactly the silent hole this shape
   * exists to close (SC-864).
   */
  readonly wallet?: WalletSpec;
}

/**
 * `chainId` is the string the wallet importer writes to
 * `accounts.metadata.chainId`, and its values come from
 * `institution_blockchain_mappings` in `0000_clean_start.sql`. Only Ethereum's
 * `'1'` is a chain number: Bitcoin and Solana are the non-EVM sentinels `'0'`
 * and `'-2'` that `sourceForChainId` dispatches on, so they look wrong and are
 * not.
 */
interface WalletSpec {
  readonly address: string;
  readonly chainId: string;
}

/**
 * Wallet addresses are the documented all-zero / burn-style placeholders
 * rather than plausible-looking ones. A demo screenshot travels, and an
 * address that looks real is an address somebody will eventually send to.
 */
export const DEMO_ACCOUNTS: readonly AccountSpec[] = [
  {
    key: 'wise-eur',
    institution: 'Wise',
    name: 'Wise EUR',
    typeCode: 'checking',
    description: 'Where both client retainers land',
  },
  {
    key: 'wise-gbp',
    institution: 'Wise',
    name: 'Wise GBP',
    typeCode: 'checking',
    description: 'Day-to-day account the bills come out of',
  },
  {
    key: 'revolut-savings',
    institution: 'Revolut',
    name: 'Revolut Savings',
    typeCode: 'savings',
    description: 'Corporation-tax reserve, 4.1% AER',
  },
  {
    key: 'ibkr',
    institution: 'Interactive Brokers',
    name: 'IBKR Brokerage',
    typeCode: 'investment',
    description: 'US-listed positions, funded in USD',
  },
  {
    key: 'kraken',
    institution: 'Kraken',
    name: 'Kraken Spot',
    typeCode: 'crypto',
    description: 'On-ramp; nothing is meant to sit here long',
  },
  {
    key: 'eth-wallet',
    institution: 'Ethereum',
    name: 'Ledger — Ethereum',
    typeCode: 'crypto',
    wallet: { address: '0x0000000000000000000000000000000000000dem0', chainId: '1' },
    description: 'Self-custody, Ethereum mainnet',
  },
  {
    key: 'btc-wallet',
    institution: 'Bitcoin',
    name: 'Ledger — Bitcoin',
    typeCode: 'crypto',
    wallet: { address: 'bc1qdem00000000000000000000000000000000000', chainId: '0' },
    description: 'Self-custody, cold storage',
  },
  {
    key: 'sol-wallet',
    institution: 'Solana',
    name: 'Phantom — Solana',
    typeCode: 'crypto',
    wallet: { address: 'Dem0000000000000000000000000000000000000000', chainId: '-2' },
    description: 'Staked with a validator',
  },
];

export interface HoldingSpec {
  readonly key: string;
  readonly accountKey: string;
  readonly symbol: string;
  readonly source: 'manual' | 'blockchain' | 'exchange';
  readonly arrival: 'unattributed' | 'auto_discovered' | 'user_confirmed';
  readonly label?: string;
}

export const DEMO_HOLDINGS: readonly HoldingSpec[] = [
  {
    key: 'wise-eur-cash',
    accountKey: 'wise-eur',
    symbol: 'EUR',
    source: 'manual',
    arrival: 'user_confirmed',
  },
  {
    key: 'wise-gbp-cash',
    accountKey: 'wise-gbp',
    symbol: 'GBP',
    source: 'manual',
    arrival: 'user_confirmed',
  },
  {
    key: 'revolut-gbp-cash',
    accountKey: 'revolut-savings',
    symbol: 'GBP',
    source: 'manual',
    arrival: 'user_confirmed',
    label: 'Corporation tax',
  },
  {
    key: 'ibkr-usd-cash',
    accountKey: 'ibkr',
    symbol: 'USD',
    source: 'manual',
    arrival: 'user_confirmed',
  },
  {
    key: 'ibkr-voo',
    accountKey: 'ibkr',
    symbol: 'VOO',
    source: 'manual',
    arrival: 'user_confirmed',
  },
  {
    key: 'ibkr-aapl',
    accountKey: 'ibkr',
    symbol: 'AAPL',
    source: 'manual',
    arrival: 'user_confirmed',
  },
  {
    key: 'ibkr-msft',
    accountKey: 'ibkr',
    symbol: 'MSFT',
    source: 'manual',
    arrival: 'user_confirmed',
  },
  {
    key: 'ibkr-nvda',
    accountKey: 'ibkr',
    symbol: 'NVDA',
    source: 'manual',
    arrival: 'user_confirmed',
  },
  {
    key: 'kraken-btc',
    accountKey: 'kraken',
    symbol: 'BTC',
    source: 'exchange',
    arrival: 'user_confirmed',
  },
  {
    key: 'kraken-eth',
    accountKey: 'kraken',
    symbol: 'ETH',
    source: 'exchange',
    arrival: 'user_confirmed',
  },
  {
    key: 'kraken-usdc',
    accountKey: 'kraken',
    symbol: 'USDC',
    source: 'exchange',
    arrival: 'user_confirmed',
  },
  {
    key: 'eth-wallet-eth',
    accountKey: 'eth-wallet',
    symbol: 'ETH',
    source: 'blockchain',
    arrival: 'user_confirmed',
  },
  {
    key: 'eth-wallet-usdc',
    accountKey: 'eth-wallet',
    symbol: 'USDC',
    source: 'blockchain',
    arrival: 'auto_discovered',
  },
  {
    key: 'btc-wallet-btc',
    accountKey: 'btc-wallet',
    symbol: 'BTC',
    source: 'blockchain',
    arrival: 'user_confirmed',
  },
  {
    key: 'sol-wallet-sol',
    accountKey: 'sol-wallet',
    symbol: 'SOL',
    source: 'blockchain',
    arrival: 'user_confirmed',
  },
];

export interface GroupSpec {
  readonly key: string;
  readonly name: string;
  readonly color: string;
  readonly description: string;
  readonly holdingKeys: readonly string[];
}

export const DEMO_GROUPS: readonly GroupSpec[] = [
  {
    key: 'liquid',
    name: 'Liquid',
    color: '#2563eb',
    description: 'Reachable within a day',
    holdingKeys: ['wise-eur-cash', 'wise-gbp-cash', 'revolut-gbp-cash', 'ibkr-usd-cash'],
  },
  {
    key: 'long-term',
    name: 'Long-term',
    color: '#7c3aed',
    description: 'Not touched before the sabbatical',
    holdingKeys: ['ibkr-voo', 'ibkr-aapl', 'ibkr-msft', 'ibkr-nvda'],
  },
  {
    key: 'self-custody',
    name: 'Self-custody',
    color: '#0d9488',
    description: 'Keys held personally, no counterparty',
    holdingKeys: ['eth-wallet-eth', 'eth-wallet-usdc', 'btc-wallet-btc', 'sol-wallet-sol'],
  },
];

export interface VaultSpec {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly targetAmount: string;
  readonly color: string;
  readonly iconName: string;
  readonly allocations: ReadonlyArray<{ holdingKey: string; percentage: number }>;
}

export const DEMO_VAULTS: readonly VaultSpec[] = [
  {
    key: 'tax-reserve',
    name: 'Tax reserve',
    description: 'January payment on account',
    targetAmount: '42000.00',
    color: '#b45309',
    iconName: 'landmark',
    allocations: [{ holdingKey: 'revolut-gbp-cash', percentage: 100 }],
  },
  {
    key: 'sabbatical',
    name: 'Sabbatical fund',
    description: 'Six months off in 2029',
    targetAmount: '60000.00',
    color: '#0891b2',
    iconName: 'palm-tree',
    allocations: [
      { holdingKey: 'ibkr-voo', percentage: 50 },
      { holdingKey: 'btc-wallet-btc', percentage: 25 },
    ],
  },
];

export interface VendorSpec {
  readonly key: string;
  readonly displayName: string;
  readonly category: string;
  readonly website: string;
}

export const DEMO_VENDORS: readonly VendorSpec[] = [
  {
    key: 'foxwood',
    displayName: 'Foxwood Lettings Ltd',
    category: 'Housing',
    website: 'https://foxwood-lettings.demo.scani.xyz',
  },
  {
    key: 'hyperoptic',
    displayName: 'Hyperoptic',
    category: 'Utilities',
    website: 'https://www.hyperoptic.com',
  },
  {
    key: 'vodafone',
    displayName: 'Vodafone UK',
    category: 'Utilities',
    website: 'https://www.vodafone.co.uk',
  },
  {
    key: 'thorne-blake',
    displayName: 'Thorne & Blake Accountants LLP',
    category: 'Professional services',
    website: 'https://thorne-blake.demo.scani.xyz',
  },
  {
    key: 'hiscox',
    displayName: 'Hiscox',
    category: 'Insurance',
    website: 'https://www.hiscox.co.uk',
  },
  {
    key: 'aws',
    displayName: 'Amazon Web Services',
    category: 'Infrastructure',
    website: 'https://aws.amazon.com',
  },
  {
    key: 'github',
    displayName: 'GitHub',
    category: 'Infrastructure',
    website: 'https://github.com',
  },
  {
    key: 'bergmann',
    displayName: 'Bergmann Digital GmbH',
    category: 'Client',
    website: 'https://bergmann-digital.demo.scani.xyz',
  },
  {
    key: 'vasseur',
    displayName: 'Atelier Vasseur SAS',
    category: 'Client',
    website: 'https://atelier-vasseur.demo.scani.xyz',
  },
];

export interface PaymentSpec {
  readonly key: string;
  readonly vendorKey: string;
  readonly direction: 'outflow' | 'inflow';
  readonly kind: 'fixed' | 'variable';
  readonly expectedAmount: string;
  readonly currency: string;
  readonly intervalUnit: 'week' | 'month' | 'quarter' | 'year';
  readonly intervalCount: number;
  /** Day-of-month the schedule lands on; the anchor is built from it. */
  readonly dayOfMonth: number;
  /** Which month of the year an annual payment falls in (1-12). */
  readonly month?: number;
  readonly accountKey: string;
  readonly notes?: string;
  /** Spread on a variable payment, as a fraction of `expectedAmount`. */
  readonly variance?: number;
}

/**
 * COMPOSITION, not just coverage. `Money` renders a dated feed, and a window
 * of single-item date groups reads as a list of dates rather than a bill run —
 * SC-84 measured each one costing ~86 CSS px and the income block falling out
 * of frame. So rent and broadband share the 1st, and AWS and GitHub share the
 * 3rd.
 */
export const DEMO_PAYMENTS: readonly PaymentSpec[] = [
  {
    key: 'rent',
    vendorKey: 'foxwood',
    direction: 'outflow',
    kind: 'fixed',
    expectedAmount: '1675.00',
    currency: 'GBP',
    intervalUnit: 'month',
    intervalCount: 1,
    dayOfMonth: 1,
    accountKey: 'wise-gbp',
    notes: 'Two-bed flat, Bristol',
  },
  {
    key: 'broadband',
    vendorKey: 'hyperoptic',
    direction: 'outflow',
    kind: 'fixed',
    expectedAmount: '42.00',
    currency: 'GBP',
    intervalUnit: 'month',
    intervalCount: 1,
    dayOfMonth: 1,
    accountKey: 'wise-gbp',
  },
  {
    key: 'aws',
    vendorKey: 'aws',
    direction: 'outflow',
    kind: 'variable',
    expectedAmount: '118.40',
    currency: 'GBP',
    intervalUnit: 'month',
    intervalCount: 1,
    dayOfMonth: 3,
    accountKey: 'wise-gbp',
    variance: 0.22,
    notes: 'Two client environments plus backups',
  },
  {
    key: 'github',
    vendorKey: 'github',
    direction: 'outflow',
    kind: 'fixed',
    expectedAmount: '21.00',
    currency: 'GBP',
    intervalUnit: 'month',
    intervalCount: 1,
    dayOfMonth: 3,
    accountKey: 'wise-gbp',
  },
  {
    key: 'mobile',
    vendorKey: 'vodafone',
    direction: 'outflow',
    kind: 'fixed',
    expectedAmount: '28.50',
    currency: 'GBP',
    intervalUnit: 'month',
    intervalCount: 1,
    dayOfMonth: 12,
    accountKey: 'wise-gbp',
  },
  {
    key: 'accountant',
    vendorKey: 'thorne-blake',
    direction: 'outflow',
    kind: 'fixed',
    expectedAmount: '300.00',
    currency: 'GBP',
    intervalUnit: 'quarter',
    intervalCount: 1,
    dayOfMonth: 20,
    accountKey: 'wise-gbp',
    notes: 'VAT return and management accounts',
  },
  {
    key: 'indemnity',
    vendorKey: 'hiscox',
    direction: 'outflow',
    kind: 'fixed',
    expectedAmount: '486.00',
    currency: 'GBP',
    intervalUnit: 'year',
    intervalCount: 1,
    dayOfMonth: 9,
    month: 5,
    accountKey: 'wise-gbp',
    notes: 'Professional indemnity, renews annually',
  },
  {
    key: 'retainer-bergmann',
    vendorKey: 'bergmann',
    direction: 'inflow',
    kind: 'fixed',
    expectedAmount: '8900.00',
    currency: 'EUR',
    intervalUnit: 'month',
    intervalCount: 1,
    dayOfMonth: 28,
    accountKey: 'wise-eur',
    notes: 'Retainer, 4 days a week',
  },
  {
    key: 'retainer-vasseur',
    vendorKey: 'vasseur',
    direction: 'inflow',
    kind: 'fixed',
    expectedAmount: '4200.00',
    currency: 'EUR',
    intervalUnit: 'month',
    intervalCount: 1,
    dayOfMonth: 15,
    accountKey: 'wise-eur',
    notes: 'Retainer, 1 day a week',
  },
];
