'use client';

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
          // Navigate back to the overview — this job no longer exists.
          router.push('/services/bullmq');
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
    <div className="flex items-center gap-3 text-sm">
      <button
        type="button"
        disabled={!canRetry || busy !== null}
        onClick={() => doAction('retry')}
        className="rounded border border-emerald-800 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-950 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {busy === 'retry' ? 'Retrying…' : 'Retry'}
      </button>
      <button
        type="button"
        disabled={busy !== null}
        onClick={() => {
          if (!confirm(`Remove job ${jobId}? This cannot be undone.`)) return;
          void doAction('remove');
        }}
        className="rounded border border-red-800 px-3 py-1 text-xs text-red-300 hover:bg-red-950 disabled:opacity-40"
      >
        {busy === 'remove' ? 'Removing…' : 'Remove'}
      </button>
      {message ? (
        <span className={message.tone === 'ok' ? 'text-emerald-400' : 'text-red-400'}>
          {message.text}
        </span>
      ) : null}
      {!canRetry ? (
        <span className="text-xs text-neutral-500">Retry is only available for failed jobs.</span>
      ) : null}
    </div>
  );
}
