import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { capList } from '../../lib/job-results';

/**
 * What a run could not do, listed short and counted whole.
 *
 * Every list of this shape in v2 slices to a cap and says nothing about the
 * remainder — "9 warning(s)" above five lines, four of them nowhere on the
 * page. The count is the full one, so the header and the list disagree and
 * nothing tells the reader which of the two they are reading.
 *
 * The lines themselves are the provider's own text and stay untranslated: an
 * upstream 400 or a parser's "row 4: no date column" is written by something
 * outside this app, and a key does not exist to translate it under. What is
 * translated is everything around them — which is also why the count is a
 * pluralised key rather than a number spliced into a noun.
 */
export function JobIssueList({
  title,
  lines,
  note,
  cap = 5,
}: {
  title: string;
  lines: readonly string[];
  /** One sentence about what the failures mean for the list above them. */
  note?: string;
  cap?: number;
}) {
  const { t } = useTranslation();
  if (lines.length === 0) return null;
  const { shown, remaining } = capList(lines, cap);

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-hover p-3">
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <h3 className="text-label">{title}</h3>
      </div>
      <ul className="flex flex-col gap-1">
        {/* Keyed by position: two chains can fail with the identical provider
            message, and de-duplicating them would drop a failure the reader
            never sees — the defect SC-139 exists about. The list is static and
            never reordered, so the index IS the identity. */}
        {shown.map((line, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: see above.
          <li key={`${index}-${line}`} className="text-caption text-muted-foreground">
            {line}
          </li>
        ))}
      </ul>
      {remaining > 0 ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.jobs.issues.more', { count: remaining })}
        </p>
      ) : null}
      {note ? <p className="text-caption text-muted-foreground">{note}</p> : null}
    </div>
  );
}
