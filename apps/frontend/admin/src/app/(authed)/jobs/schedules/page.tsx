import { formatRelative } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { ActionDialog } from '@/components/ActionDialog';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getScheduledJobs } from '@/lib/clients/scheduledJobs';
import { writesEnabled } from '@/lib/writes';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default function SchedulesPage() {
  const fetchedAt = new Date().toISOString();
  const schedules = getScheduledJobs();
  const writes = writesEnabled();

  return (
    <>
      <PageHeader
        title="Scheduled jobs"
        description={
          <>
            BullMQ repeatable jobs registered from{' '}
            <code className="font-mono text-xs">REPEATABLE_SCHEDULES</code> in{' '}
            <code className="font-mono text-xs">@scani/queue</code>. Last-run / run-history tracking
            needs worker-side instrumentation and is a follow-up.
          </>
        }
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total schedules" value={schedules.length} />
        <StatCard
          label="Minute"
          value={schedules.filter((s) => s.pattern === '* * * * *').length}
        />
        <StatCard
          label="Hourly"
          value={schedules.filter((s) => s.pattern === '0 * * * *').length}
        />
        <StatCard label="Daily" value={schedules.filter((s) => s.pattern === '0 0 * * *').length} />
      </div>

      <SectionCard
        title="Schedules"
        description="Cron patterns are UTC. Next-run is computed from the pattern at page load."
        className="mt-6"
        flushBody
      >
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job</TableHead>
                <TableHead>Pattern</TableHead>
                <TableHead>Cadence</TableHead>
                <TableHead>Next run</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {schedules.map((s) => (
                <TableRow key={s.name}>
                  <TableCell className="font-mono text-xs">{s.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-mono">
                      {s.pattern}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{s.cadence}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {s.nextRunAt ? formatRelative(s.nextRunAt) : '—'}
                  </TableCell>
                  <TableCell className="max-w-md text-xs text-muted-foreground">
                    {s.description}
                  </TableCell>
                  <TableCell className="text-right">
                    <ActionDialog
                      endpoint="/api/admin/schedules/run"
                      payload={{ name: s.name }}
                      label="Run now"
                      title={`Trigger ${s.name}?`}
                      description={
                        <>
                          Enqueues a one-shot run of <span className="font-mono">{s.name}</span>{' '}
                          right now in addition to its scheduled cron pattern. Useful for testing
                          fixes without waiting for the next cycle.
                        </>
                      }
                      confirmLabel="Run now"
                      enabled={writes}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </SectionCard>
    </>
  );
}
