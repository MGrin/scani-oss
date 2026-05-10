import { Banknote, Bitcoin, Wallet } from 'lucide-react';

interface Bucket {
  Icon: typeof Banknote;
  title: string;
  description: string;
  examples: string[];
}

// Examples are illustrative, not exhaustive — `+ N more` lets us add
// providers without rewriting the page. Edit the chip list when the
// shipped names shift, but resist the urge to enumerate every provider.
const BUCKETS: ReadonlyArray<Bucket> = [
  {
    Icon: Banknote,
    title: 'Banks & brokerages',
    description:
      'Checking, savings, and investment accounts pulled via direct broker and bank APIs.',
    examples: ['IBKR', 'Wise', 'Yahoo Finance', 'Finnhub'],
  },
  {
    Icon: Bitcoin,
    title: 'Crypto exchanges & custody',
    description:
      'Centralized exchanges sync over read-only API keys; pricing data from major aggregators.',
    examples: ['Binance', 'Kraken', 'Coinbase', 'OKX', '+ 8 more'],
  },
  {
    Icon: Wallet,
    title: 'On-chain & DeFi',
    description:
      'Self-custody balances, staking positions, and DeFi yield from explorers and indexers.',
    examples: ['Bitcoin', 'EVM chains', 'Solana', 'TON', 'Tron', 'DeFiLlama'],
  },
];

export function Problem() {
  return (
    <section className="border-b border-border/60 bg-background py-20 sm:py-28">
      <div className="mx-auto max-w-6xl px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            The problem
          </p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Your money lives in 14 different apps. Your view of it shouldn't.
          </h2>
          <p className="mt-4 text-balance text-muted-foreground">
            Most personal-finance tools cover one slice — bank accounts, or crypto, or stocks. Scani
            plugs into all three at once and reconciles them into one accurate balance.
          </p>
        </div>
        <div className="mt-14 grid gap-6 md:grid-cols-3">
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
