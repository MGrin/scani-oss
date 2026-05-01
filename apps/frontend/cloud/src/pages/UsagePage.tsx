import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { trpc } from '../lib/trpc';

interface Range {
  label: string;
  days: number;
}
const RANGES: Range[] = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
];

export function UsagePage() {
  const [range, setRange] = useState<Range>(RANGES[1]!);
  const from = useMemo(
    () => new Date(Date.now() - range.days * 24 * 3600 * 1000).toISOString(),
    [range]
  );

  const summary = trpc.usage.summary.useQuery({ from });
  const daily = trpc.usage.daily.useQuery({ from });
  const breakdown = trpc.usage.breakdown.useQuery({ from });

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Usage</h1>
          <p className="text-sm text-muted-foreground">
            Per-request metering across your API keys.
          </p>
        </div>
        <div className="inline-flex rounded-lg border bg-card p-1">
          {RANGES.map((r) => (
            <button
              key={r.label}
              type="button"
              onClick={() => setRange(r)}
              className={`rounded-md px-3 py-1 text-xs transition-colors ${
                range.label === r.label
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Stat label="Requests" value={summary.data?.totalRequests ?? 0} />
        <Stat label="Upstream cost" value={`$${(summary.data?.totalCostUsd ?? 0).toFixed(2)}`} />
        <Stat label="Error rate" value={`${((summary.data?.errorRate ?? 0) * 100).toFixed(2)}%`} />
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Requests over time</CardTitle>
        </CardHeader>
        <CardContent className="h-72">
          {daily.data && daily.data.length > 0 ? (
            <ResponsiveContainer>
              <BarChart data={daily.data}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis dataKey="day" className="text-xs" />
                <YAxis className="text-xs" />
                <Tooltip />
                <Legend />
                <Bar dataKey="requests" name="Requests" fill="hsl(var(--primary))" />
                <Bar dataKey="errors" name="Errors" fill="hsl(var(--destructive))" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No requests in this window yet.
            </div>
          )}
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Top routes</CardTitle>
          </CardHeader>
          <CardContent>
            {breakdown.data && breakdown.data.byRoute.length > 0 ? (
              <div className="divide-y">
                {breakdown.data.byRoute.slice(0, 10).map((r) => (
                  <div key={r.route} className="flex items-center justify-between py-2 text-sm">
                    <span className="font-mono">{r.route}</span>
                    <span className="text-muted-foreground">{r.requests.toLocaleString()} req</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-6 text-sm text-muted-foreground">No data.</div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>By provider</CardTitle>
          </CardHeader>
          <CardContent>
            {breakdown.data && breakdown.data.byProvider.length > 0 ? (
              <div className="divide-y">
                {breakdown.data.byProvider.slice(0, 10).map((p) => (
                  <div
                    key={p.provider ?? 'unknown'}
                    className="flex items-center justify-between py-2 text-sm"
                  >
                    <span className="font-mono">{p.provider ?? 'unknown'}</span>
                    <span className="text-muted-foreground">${p.costUsd.toFixed(2)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="py-6 text-sm text-muted-foreground">No data.</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardContent className="py-6">
        <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
        <div className="mt-1 text-2xl font-semibold">{value}</div>
      </CardContent>
    </Card>
  );
}
