import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { AlertTriangle, CheckCircle2, PieChart } from 'lucide-react';
import { Link } from 'react-router-dom';
import { V2_ROUTES } from '../../lib/routes';

/**
 * Detail-page body for `exchange-import` jobs (all 13 exchange/broker
 * integrations share this one use case). Previously rendered raw JSON —
 * now shows a structured summary + CTA to the holdings page.
 */

interface ExchangeImportResultShape {
  accountsCreated?: number;
  tokensImported?: number;
  errors?: Array<{ accountType?: string; error?: string }>;
  institutionId?: string;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export function ExchangeImportResult({ result }: { result: unknown }) {
  const raw = asRecord(result) as ExchangeImportResultShape & Record<string, unknown>;
  const accountsCreated = Number(raw.accountsCreated ?? 0);
  const tokensImported = Number(raw.tokensImported ?? 0);
  const errors = Array.isArray(raw.errors) ? raw.errors : [];
  const institutionId = typeof raw.institutionId === 'string' ? raw.institutionId : null;

  const hasErrors = errors.length > 0;
  const allFailed = tokensImported === 0 && hasErrors;

  const holdingsHref = institutionId
    ? `${V2_ROUTES.holdings}?institution=${institutionId}`
    : V2_ROUTES.holdings;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center gap-2 space-y-0">
          {allFailed ? (
            <AlertTriangle className="h-4 w-4 text-destructive" />
          ) : hasErrors ? (
            <AlertTriangle className="h-4 w-4 text-amber-500" />
          ) : (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          )}
          <CardTitle className="text-sm">Exchange import</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-md border border-border p-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Accounts created
              </div>
              <div className="text-sm font-medium tabular-nums">{accountsCreated}</div>
            </div>
            <div className="rounded-md border border-border p-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Holdings imported
              </div>
              <div className="text-sm font-medium tabular-nums">{tokensImported}</div>
            </div>
          </div>

          {tokensImported > 0 && (
            <Button asChild size="sm">
              <Link to={holdingsHref}>
                <PieChart className="h-3.5 w-3.5 mr-1" />
                View imported holdings
              </Link>
            </Button>
          )}

          {hasErrors && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 space-y-1">
              <div className="text-xs font-medium">{errors.length} error(s)</div>
              <ul className="list-disc pl-4 space-y-0.5 text-xs font-mono">
                {errors.slice(0, 10).map((e, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: error objects aren't identified
                  <li key={i}>
                    {e.accountType ? `[${e.accountType}] ` : ''}
                    {e.error ?? JSON.stringify(e)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!hasErrors && tokensImported === 0 && accountsCreated > 0 && (
            <p className="text-xs text-muted-foreground">
              Your accounts connected successfully but no funds were returned by the provider. This
              is normal if the accounts are empty. Any balances added later will sync on the next
              hourly refresh.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
