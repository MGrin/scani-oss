import { useState } from 'react';
import { NetWorthChart, type NetWorthChartScope } from './NetWorthChart';
import { PnLChart } from './PnLChart';

export interface PortfolioChartsProps {
  scope?: NetWorthChartScope;
  netWorthTitle?: string;
  pnlTitle?: string;
}

// Tabbed container that lets the user toggle between Net worth and
// PnL views without managing two separate chart cards. Same surface
// renders on the dashboard + each detail page (institution, account,
// holding) — the optional `scope` flows through to both children.
export function PortfolioCharts({ scope, netWorthTitle, pnlTitle }: PortfolioChartsProps = {}) {
  const [tab, setTab] = useState<'net-worth' | 'pnl'>('net-worth');

  return (
    <div className="space-y-2">
      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => setTab('net-worth')}
          className={`px-3 py-1 text-xs rounded ${
            tab === 'net-worth'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:bg-muted/80'
          }`}
        >
          Net worth
        </button>
        <button
          type="button"
          onClick={() => setTab('pnl')}
          className={`px-3 py-1 text-xs rounded ${
            tab === 'pnl'
              ? 'bg-primary text-primary-foreground'
              : 'bg-muted text-muted-foreground hover:bg-muted/80'
          }`}
        >
          PnL
        </button>
      </div>
      {tab === 'net-worth' ? (
        <NetWorthChart
          {...(scope ? { scope } : {})}
          {...(netWorthTitle ? { title: netWorthTitle } : {})}
        />
      ) : (
        <PnLChart {...(scope ? { scope } : {})} {...(pnlTitle ? { title: pnlTitle } : {})} />
      )}
    </div>
  );
}
