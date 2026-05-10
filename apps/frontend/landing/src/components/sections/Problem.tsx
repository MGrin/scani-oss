import { Banknote, Bitcoin, LineChart, Wallet } from 'lucide-react';
import { useRevealOnScroll } from '../../hooks/useRevealOnScroll';

interface Bucket {
  Icon: typeof Banknote;
  title: string;
  description: string;
  examples: string[];
}

// Examples are illustrative, not exhaustive. The first three buckets
// list where the *balances and transactions* come from; the fourth
// lists where the *prices* come from — they're a different concern
// and need their own surface so visitors can see the asset-class
// coverage.
const BUCKETS: ReadonlyArray<Bucket> = [
  {
    Icon: Banknote,
    title: 'Banks & brokerages',
    description:
      'Checking, savings, and investment accounts pulled via direct broker and bank APIs.',
    examples: ['IBKR', 'Wise'],
  },
  {
    Icon: Bitcoin,
    title: 'Crypto exchanges & custody',
    description:
      'Centralized exchanges sync over read-only API keys; balances refresh on a schedule.',
    examples: ['Binance', 'Kraken', 'Coinbase', 'OKX', '+ 8 more'],
  },
  {
    Icon: Wallet,
    title: 'On-chain & DeFi',
    description:
      'Self-custody balances, staking positions, and DeFi yield from explorers and indexers.',
    examples: ['Bitcoin', 'EVM chains', 'Solana', 'TON', 'Tron'],
  },
  {
    Icon: LineChart,
    title: 'Prices for everything you hold',
    description:
      'Spot, historical, and FX rates for every asset class — crypto, equities (US and non-US), and fiat. Backfilled overnight, refreshed live during the day.',
    examples: ['CoinGecko', 'DeFiLlama', 'Yahoo Finance', 'Finnhub', 'Frankfurter'],
  },
];

export function Problem() {
  const ref = useRevealOnScroll<HTMLElement>();
  return (
    <section
      ref={ref}
      data-reveal="section"
      className="border-b border-border/60 bg-background py-12 sm:py-20 lg:py-28"
    >
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            The problem
          </p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Your money lives across too many apps. Your view of it shouldn't.
          </h2>
          <p className="mt-4 text-balance text-muted-foreground">
            Most personal-finance tools cover one slice — bank accounts, or crypto, or stocks. Scani
            plugs into all of them and reconciles them into one accurate balance.
          </p>
        </div>
        <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {BUCKETS.map(({ Icon, title, description, examples }) => (
            <div
              key={title}
              className="rounded-xl border border-border bg-card p-6 transition-colors hover:border-border/80"
            >
              <Icon className="h-5 w-5 text-foreground" />
              <h3 className="mt-4 font-semibold">{title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{description}</p>
              <ul className="mt-4 flex flex-wrap gap-1.5">
                {examples.map((ex) => (
                  <li
                    key={ex}
                    className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
                  >
                    {ex}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
