'use client';

import { Button } from '@scani/ui/ui/button';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { JobState } from '@/lib/clients/bullmq';

interface JobActionsProps {
  jobId: string;
  state: JobState | 'unknown';
}

export function JobActions({ jobId, state }: JobActionsProps) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'retry' | 'remove'>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const canRetry = state === 'failed';

  const doAction = async (action: 'retry' | 'remove') => {
    setBusy(action);
    setMessage(null);
    try {
      const res = await fetch(`/api/bullmq/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jobId }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || json.error || !json.ok) {
        setMessage({ tone: 'err', text: json.error ?? `HTTP ${res.status}` });
      } else {
        setMessage({ tone: 'ok', text: action === 'retry' ? 'Queued for retry' : 'Removed' });
        if (action === 'remove') {
          router.push('/jobs/queue');
          return;
        }
        router.refresh();
      }
    } catch (err) {
      setMessage({
        tone: 'err',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={!canRetry || busy !== null}
        onClick={() => doAction('retry')}
      >
        {busy === 'retry' ? 'Retrying…' : 'Retry'}
      </Button>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={busy !== null}
        onClick={() => {
          if (typeof window !== 'undefined') {
            if (!window.confirm(`Remove job ${jobId}? This cannot be undone.`)) return;
          }
          void doAction('remove');
        }}
      >
        {busy === 'remove' ? 'Removing…' : 'Remove'}
      </Button>
      {message ? (
        <span className={message.tone === 'ok' ? 'text-emerald-500' : 'text-destructive'}>
          {message.text}
        </span>
      ) : null}
      {!canRetry ? (
        <span className="text-xs text-muted-foreground">
          Retry is only available for failed jobs.
        </span>
      ) : null}
    </div>
  );
}
