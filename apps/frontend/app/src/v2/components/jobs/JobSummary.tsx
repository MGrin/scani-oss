/**
 * Tiny per-jobName summary used in the /jobs list row and detail header.
 * Reads the sanitized `payload_summary` jsonb written by the backend's
 * `summarizePayload` — keep the field names here aligned with that file.
 */

interface JobSummaryProps {
  jobName: string;
  payloadSummary: unknown;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export function JobSummary({ jobName, payloadSummary }: JobSummaryProps) {
  const s = asRecord(payloadSummary);
  switch (jobName) {
    case 'wallet-import':
      return (
        <span className="text-xs text-muted-foreground">
          {String(s.chain ?? 'chain')} · {String(s.address ?? '')}
          {s.label ? ` · ${String(s.label)}` : ''}
        </span>
      );
    case 'screenshot-parse': {
      // Intentionally omit the AI provider field
      // — it's internal implementation detail, not user-facing value.
      const n = Number(s.fileCount ?? 0);
      const label = `${n || '?'} file${n === 1 ? '' : 's'}`;
      return <span className="text-xs text-muted-foreground">{label}</span>;
    }
    case 'exchange-import':
      return (
        <span className="text-xs text-muted-foreground">{String(s.provider ?? 'exchange')}</span>
      );
    case 'file-import':
      return (
        <span className="text-xs text-muted-foreground">
          {String(s.fileType ?? 'file')}
          {s.enrich ? ' · enriched' : ''}
        </span>
      );
    case 'holding-price-update':
      return <span className="text-xs text-muted-foreground">holding price refresh</span>;
    case 'user-data-delete':
      return <span className="text-xs text-muted-foreground">delete all account data</span>;
    default:
      return null;
  }
}
