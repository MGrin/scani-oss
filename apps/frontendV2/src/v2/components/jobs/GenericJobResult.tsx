import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Fallback body for job types that don't have a dedicated renderer. We
 * used to `JSON.stringify` the entire result blob straight to the DOM —
 * that's a debugging view, not a user-facing one. This version renders a
 * structured summary drawn from the common fields jobs tend to emit, and
 * tucks the raw payload behind a `<details>` for power users / support.
 */

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export function GenericJobResult({ result }: { result: unknown }) {
  if (result == null) {
    return (
      <Card>
        <CardContent className="p-4 text-xs text-muted-foreground">
          The job completed without a result payload. No follow-up action needed.
        </CardContent>
      </Card>
    );
  }

  const r = asRecord(result);

  // Shape-hunt the common fields workers emit. Everything is optional;
  // the component just skips sections it can't find data for.
  const message =
    typeof r.message === 'string' ? r.message : typeof r.summary === 'string' ? r.summary : null;
  const errorsRaw = Array.isArray(r.errors) ? (r.errors as unknown[]) : [];
  const errors = errorsRaw.map((e) => {
    if (typeof e === 'string') return e;
    const rec = asRecord(e);
    return typeof rec.error === 'string' ? rec.error : JSON.stringify(e);
  });

  // Generic numeric stats — render any numeric top-level key as a stat pill.
  const stats = Object.entries(r).filter(
    ([, value]) => typeof value === 'number' && Number.isFinite(value)
  ) as Array<[string, number]>;

  const hasErrors = errors.length > 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        {hasErrors ? (
          <AlertTriangle className="h-4 w-4 text-amber-500" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-emerald-500" />
        )}
        <CardTitle className="text-sm">{hasErrors ? 'Completed with issues' : 'Result'}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {message && <p className="text-sm">{message}</p>}

        {stats.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {stats.map(([key, value]) => (
              <div key={key} className="rounded-md border border-border p-2">
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {humanize(key)}
                </div>
                <div className="text-sm font-medium tabular-nums">{value.toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}

        {hasErrors && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 space-y-1">
            <div className="text-xs font-medium">{errors.length} error(s)</div>
            <ul className="list-disc pl-4 space-y-0.5 text-xs font-mono">
              {errors.slice(0, 10).map((e, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: error strings aren't identified
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}

        {!message && stats.length === 0 && !hasErrors && (
          <p className="text-xs text-muted-foreground">No summary available for this job type.</p>
        )}

        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Raw result
          </summary>
          <pre className="mt-2 text-[11px] font-mono whitespace-pre-wrap break-all rounded-md bg-muted/50 p-2">
            {JSON.stringify(result, null, 2)}
          </pre>
        </details>
      </CardContent>
    </Card>
  );
}

/** Turn `accountsCreated` / `snake_case` → `Accounts Created`. */
function humanize(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}
