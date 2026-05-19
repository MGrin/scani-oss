// Plain data — no React/icon imports. Imported both by the comparison
// page components and by the build-time prerender + sitemap scripts, so
// it must stay free of any browser-only dependency.
//
// Competitor claims here are factual at time of writing and intended to
// be neutral. Re-verify against each competitor's site before publishing
// material changes — misrepresenting a competitor is a trust + SEO risk.

export interface ComparisonFeatureRow {
  feature: string;
  scani: string;
  competitor: string;
}

export interface Comparison {
  slug: string;
  /** Competitor display name. */
  competitor: string;
  competitorUrl: string;
  /** <title> for the page. */
  metaTitle: string;
  metaDescription: string;
  /** Visible H1. */
  heading: string;
  tagline: string;
  /** Body paragraphs above the feature table. */
  intro: string[];
  featureRows: ComparisonFeatureRow[];
  /** Short closing paragraph. */
  verdict: string;
}

const SCANI = {
  banks: 'IBKR, Wise — direct broker & bank APIs',
  exchanges: 'Binance, Kraken, Coinbase, OKX + more — read-only keys',
  onchain: 'Bitcoin, EVM chains, Solana, TON, Tron',
  equities: 'Via connected brokerages, with live + historical pricing',
  openSource: 'In preparation — permissive-licensed release coming',
  selfHost: 'Planned — dedicated self-host tier',
  managed: 'Yes — fully managed SaaS',
  api: 'Yes — metered, type-safe Cloud API',
  pricing: 'Free during beta · 1 year free at every paid tier for signups',
} as const;

export const COMPARISONS: readonly Comparison[] = [
  {
    slug: 'ghostfolio',
    competitor: 'Ghostfolio',
    competitorUrl: 'https://ghostfol.io',
    metaTitle: 'Scani vs Ghostfolio — a Ghostfolio alternative with live account sync',
    metaDescription:
      'Compare Scani and Ghostfolio: open-source wealth tracking, self-hosting, and how each gets data in. Scani syncs banks, brokerages, exchanges, and on-chain wallets automatically.',
    heading: 'Scani vs Ghostfolio',
    tagline: 'Both track your whole net worth. They differ on how the data gets in.',
    intro: [
      'Ghostfolio is a well-loved open-source (AGPLv3) wealth manager for stocks, ETFs, and crypto. You add positions through manual transaction entry or by importing files — there is no automatic linking to your bank, brokerage, or exchange.',
      'Scani is built around live account sync: it connects directly to broker and bank APIs, centralized exchanges over read-only keys, and public on-chain addresses, then reconciles everything into one real-time portfolio. It ships as a managed SaaS, a metered Cloud API, and a self-host tier.',
    ],
    featureRows: [
      {
        feature: 'Banks & brokerages',
        scani: SCANI.banks,
        competitor: 'Manual entry or file import',
      },
      {
        feature: 'Crypto exchanges',
        scani: SCANI.exchanges,
        competitor: 'Manual entry or file import',
      },
      { feature: 'On-chain wallets & DeFi', scani: SCANI.onchain, competitor: 'Manual entry' },
      {
        feature: 'Stocks & ETFs',
        scani: SCANI.equities,
        competitor: 'Yes — manual entry or import',
      },
      { feature: 'Open source', scani: SCANI.openSource, competitor: 'Yes — AGPLv3' },
      { feature: 'Self-hostable', scani: SCANI.selfHost, competitor: 'Yes — Docker' },
      {
        feature: 'Managed cloud option',
        scani: SCANI.managed,
        competitor: 'Yes — Ghostfolio Premium',
      },
      { feature: 'Developer API', scani: SCANI.api, competitor: 'Not a marketed product API' },
      {
        feature: 'Pricing',
        scani: SCANI.pricing,
        competitor: 'Free self-host · paid Premium cloud',
      },
    ],
    verdict:
      'Pick Ghostfolio if you want a mature open-source tracker today and are happy entering or importing transactions yourself. Pick Scani if you want balances that sync themselves across banks, brokerages, exchanges, and chains — with a managed option and a developer API.',
  },
  {
    slug: 'rotki',
    competitor: 'rotki',
    competitorUrl: 'https://rotki.com',
    metaTitle: 'Scani vs rotki — a rotki alternative across banks, brokerages & crypto',
    metaDescription:
      'Compare Scani and rotki: rotki is a privacy-first, local crypto portfolio tool. Scani consolidates banks, brokerages, exchanges, and on-chain wallets, self-hosted or managed.',
    heading: 'Scani vs rotki',
    tagline: 'rotki is crypto-first and local-only. Scani spans every asset class.',
    intro: [
      'rotki is an open-source (AGPLv3), privacy-first portfolio tracker that runs locally and keeps your data encrypted on your own machine. It is strongest on crypto: exchange sync, on-chain balances, DeFi, and profit/loss accounting for tax.',
      'Scani covers crypto too, but reaches further — banks and brokerages via direct APIs alongside exchanges and on-chain wallets. It runs as a desktop-free web app you can self-host or let us manage, and exposes a metered API for builders.',
    ],
    featureRows: [
      { feature: 'Banks & brokerages', scani: SCANI.banks, competitor: 'Not the focus' },
      {
        feature: 'Crypto exchanges',
        scani: SCANI.exchanges,
        competitor: 'Yes — extensive exchange support',
      },
      {
        feature: 'On-chain wallets & DeFi',
        scani: SCANI.onchain,
        competitor: 'Yes — strong on-chain & DeFi',
      },
      { feature: 'Stocks & ETFs', scani: SCANI.equities, competitor: 'Limited' },
      { feature: 'Open source', scani: SCANI.openSource, competitor: 'Yes — AGPLv3' },
      {
        feature: 'Self-hostable',
        scani: SCANI.selfHost,
        competitor: 'Yes — runs locally, data stays local',
      },
      {
        feature: 'Managed cloud option',
        scani: SCANI.managed,
        competitor: 'No — local desktop app',
      },
      { feature: 'Developer API', scani: SCANI.api, competitor: 'Not a marketed product API' },
      { feature: 'Pricing', scani: SCANI.pricing, competitor: 'Free · paid Pro tier' },
    ],
    verdict:
      'Pick rotki if your portfolio is mostly crypto and you want a privacy-first, fully local tool with tax accounting. Pick Scani if you also hold cash, equities, and bank balances and want one consolidated view — managed or self-hosted.',
  },
  {
    slug: 'kubera',
    competitor: 'Kubera',
    competitorUrl: 'https://www.kubera.com',
    metaTitle: 'Scani vs Kubera — a Kubera alternative you can self-host',
    metaDescription:
      'Compare Scani and Kubera: Kubera is a polished proprietary net-worth tracker. Scani offers the same multi-asset coverage with a developer API and a planned self-host tier.',
    heading: 'Scani vs Kubera',
    tagline: 'Kubera is closed and subscription-only. Scani gives you deployment choice.',
    intro: [
      'Kubera is a proprietary net-worth tracker that aggregates banks, brokerages, crypto, real estate, and alternative assets through account aggregators. It is a polished managed product — but it is not open-source, cannot be self-hosted, and starts at a yearly subscription.',
      'Scani delivers the same kind of multi-asset consolidation — banks, brokerages, exchanges, and on-chain wallets — but lets you choose the deployment that matches your trust model: a managed SaaS, a metered Cloud API, or a self-host tier on your own infrastructure.',
    ],
    featureRows: [
      {
        feature: 'Banks & brokerages',
        scani: SCANI.banks,
        competitor: 'Yes — via account aggregators',
      },
      {
        feature: 'Crypto exchanges',
        scani: SCANI.exchanges,
        competitor: 'Yes — wallets & exchanges',
      },
      {
        feature: 'On-chain wallets & DeFi',
        scani: SCANI.onchain,
        competitor: 'Yes — digital assets, DeFi, NFTs',
      },
      { feature: 'Stocks & ETFs', scani: SCANI.equities, competitor: 'Yes' },
      { feature: 'Open source', scani: SCANI.openSource, competitor: 'No — proprietary' },
      { feature: 'Self-hostable', scani: SCANI.selfHost, competitor: 'No — managed SaaS only' },
      { feature: 'Managed cloud option', scani: SCANI.managed, competitor: 'Yes' },
      { feature: 'Developer API', scani: SCANI.api, competitor: 'Not a marketed product API' },
      { feature: 'Pricing', scani: SCANI.pricing, competitor: 'Paid annual subscription' },
    ],
    verdict:
      'Pick Kubera if you want a finished, hands-off product today and the subscription is no obstacle. Pick Scani if you want the same coverage with a developer API, beta pricing, and the option to run it yourself.',
  },
  {
    slug: 'coinstats',
    competitor: 'CoinStats',
    competitorUrl: 'https://coinstats.app',
    metaTitle: 'Scani vs CoinStats — a CoinStats alternative beyond crypto',
    metaDescription:
      'Compare Scani and CoinStats: CoinStats is a crypto-focused portfolio tracker. Scani consolidates crypto with banks and brokerages, self-hosted or managed, with a developer API.',
    heading: 'Scani vs CoinStats',
    tagline: 'CoinStats stops at crypto. Scani covers your whole balance sheet.',
    intro: [
      'CoinStats is a proprietary crypto portfolio tracker that connects hundreds of wallets and exchanges and covers DeFi and NFTs across many chains. It is crypto-native — but your bank accounts and brokerage holdings live somewhere else.',
      'Scani tracks crypto exchanges and on-chain wallets too, then adds direct bank and brokerage connections so cash, equities, and crypto reconcile into a single real-time total. It is available self-hosted, as a managed SaaS, and as a metered API.',
    ],
    featureRows: [
      { feature: 'Banks & brokerages', scani: SCANI.banks, competitor: 'Not the focus' },
      {
        feature: 'Crypto exchanges',
        scani: SCANI.exchanges,
        competitor: 'Yes — extensive coverage',
      },
      {
        feature: 'On-chain wallets & DeFi',
        scani: SCANI.onchain,
        competitor: 'Yes — many chains, DeFi & NFTs',
      },
      { feature: 'Stocks & ETFs', scani: SCANI.equities, competitor: 'Limited' },
      { feature: 'Open source', scani: SCANI.openSource, competitor: 'No — proprietary' },
      { feature: 'Self-hostable', scani: SCANI.selfHost, competitor: 'No — managed SaaS & apps' },
      { feature: 'Managed cloud option', scani: SCANI.managed, competitor: 'Yes' },
      { feature: 'Developer API', scani: SCANI.api, competitor: 'Yes — crypto data API' },
      { feature: 'Pricing', scani: SCANI.pricing, competitor: 'Freemium · paid premium tiers' },
    ],
    verdict:
      'Pick CoinStats if your portfolio is crypto-only and you want a crypto-native app. Pick Scani if you want crypto and traditional finance reconciled in one place — with self-host and managed options.',
  },
  {
    slug: 'maybe-finance',
    competitor: 'Maybe Finance',
    competitorUrl: 'https://github.com/we-promise/sure',
    metaTitle: 'Scani vs Maybe Finance — a self-hosted Maybe Finance alternative',
    metaDescription:
      'Compare Scani and Maybe Finance (the community "sure" fork): both can be self-hosted. Scani adds first-class crypto and on-chain coverage alongside banks and brokerages.',
    heading: 'Scani vs Maybe Finance',
    tagline: 'Maybe is general personal finance. Scani is built for crypto + traditional together.',
    intro: [
      'Maybe Finance was an open-source personal finance app; after the company wound down, the code was open-sourced (AGPLv3) and the community now maintains the "sure" fork. It is a self-hostable budgeting and net-worth app focused on traditional personal finance.',
      'Scani is also designed to be self-hosted, but its core is multi-asset consolidation — banks and brokerages alongside first-class crypto exchange and on-chain coverage — with arbitrary-precision accounting and a managed cloud and API on the same codebase.',
    ],
    featureRows: [
      {
        feature: 'Banks & brokerages',
        scani: SCANI.banks,
        competitor: 'Yes — bank linking + manual',
      },
      { feature: 'Crypto exchanges', scani: SCANI.exchanges, competitor: 'Limited' },
      { feature: 'On-chain wallets & DeFi', scani: SCANI.onchain, competitor: 'Limited' },
      { feature: 'Stocks & ETFs', scani: SCANI.equities, competitor: 'Yes' },
      {
        feature: 'Open source',
        scani: SCANI.openSource,
        competitor: 'Yes — AGPLv3, community-maintained',
      },
      { feature: 'Self-hostable', scani: SCANI.selfHost, competitor: 'Yes — Docker' },
      {
        feature: 'Managed cloud option',
        scani: SCANI.managed,
        competitor: 'No official managed offering',
      },
      { feature: 'Developer API', scani: SCANI.api, competitor: 'Not a marketed product API' },
      { feature: 'Pricing', scani: SCANI.pricing, competitor: 'Free — self-host' },
    ],
    verdict:
      'Pick Maybe Finance / sure if you want an open-source budgeting and personal-finance app and crypto is a minor part of your portfolio. Pick Scani if crypto and on-chain assets matter and you want a managed option as well as self-hosting.',
  },
  {
    slug: 'myfinancetools',
    competitor: 'MyFinanceTools',
    competitorUrl: 'https://myfinancetools.io',
    metaTitle: 'Scani vs MyFinanceTools — an automated portfolio-tracking alternative',
    metaDescription:
      'Compare Scani and MyFinanceTools: MyFinanceTools offers finance calculators and portfolio tracking. Scani automatically syncs banks, brokerages, exchanges, and on-chain wallets.',
    heading: 'Scani vs MyFinanceTools',
    tagline: 'MyFinanceTools is calculators plus tracking. Scani is automated account sync.',
    intro: [
      'MyFinanceTools is a proprietary web app offering a suite of free financial calculators alongside portfolio tracking across cash, investments, retirement accounts, crypto, and real estate.',
      'Scani focuses on one job and automates it: connecting directly to banks, brokerages, crypto exchanges, and on-chain wallets so balances reconcile into a single real-time portfolio — with self-host, managed, and API deployment options.',
    ],
    featureRows: [
      { feature: 'Banks & brokerages', scani: SCANI.banks, competitor: 'Tracked — manual-first' },
      { feature: 'Crypto exchanges', scani: SCANI.exchanges, competitor: 'Tracked' },
      { feature: 'On-chain wallets & DeFi', scani: SCANI.onchain, competitor: 'Limited' },
      { feature: 'Stocks & ETFs', scani: SCANI.equities, competitor: 'Yes' },
      { feature: 'Open source', scani: SCANI.openSource, competitor: 'No — proprietary' },
      { feature: 'Self-hostable', scani: SCANI.selfHost, competitor: 'No — hosted web app' },
      { feature: 'Managed cloud option', scani: SCANI.managed, competitor: 'Yes' },
      { feature: 'Developer API', scani: SCANI.api, competitor: 'Not a marketed product API' },
      { feature: 'Pricing', scani: SCANI.pricing, competitor: 'Free core · optional support' },
    ],
    verdict:
      'Pick MyFinanceTools if you want free financial calculators with light portfolio tracking. Pick Scani if you want hands-off, automatic consolidation across every account you hold.',
  },
];

export const COMPARISON_SLUGS: readonly string[] = COMPARISONS.map((c) => c.slug);

export function getComparison(slug: string | undefined): Comparison | undefined {
  if (!slug) return undefined;
  return COMPARISONS.find((c) => c.slug === slug);
}
