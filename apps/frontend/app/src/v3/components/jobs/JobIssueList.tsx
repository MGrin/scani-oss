import type { TFunction } from 'i18next';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { capList, type JobLine } from '../../lib/job-results';

/**
 * What a run could not do, listed short and counted whole.
 *
 * Every list of this shape in v2 slices to a cap and says nothing about the
 * remainder — "9 warning(s)" above five lines, four of them nowhere on the
 * page. The count is the full one, so the header and the list disagree and
 * nothing tells the reader which of the two they are reading.
 *
 * A line is translated when the server said what key it goes under, and left
 * alone when it did not (SC-434). The rule this replaces was right about the
 * upstream case and wrong about ours: an upstream 400 or a parser's "row 4:
 * no date column" really is written by something outside this app, but every
 * warning production has ever stored was written by our own server, and a
 * Russian reader met all of them in English under a translated heading.
 *
 * `defaultValue` is what makes the key safe to send. A key this build does
 * not carry — a locale not written yet, a result stored by a newer server,
 * an old service worker behind a new API — renders the server's English
 * sentence rather than the raw key, so the worst case is exactly the
 * behaviour that shipped before any of this.
 */
/**
 * The line a reader sees: translated when we can, and what the server wrote
 * when we cannot (SC-434).
 *
 * `i18n.exists` rather than `defaultValue`, and the difference is not style.
 * `i18n-keys.test.ts` forbids a `defaultValue` anywhere under the keyed roots
 * because an English sentence written beside a key is how two spellings of
 * one sentence start drifting — the translator sees `en.json` and the reader
 * sees the default. That rule is right and this is not the case it is about:
 * nothing here is written in this file, `line.text` arrives at runtime from a
 * job result. Asking whether the key resolves says the same thing without
 * weakening a guard that has caught real drift.
 *
 * A key that does not resolve is the ordinary case, not a bug: a result
 * stored before the key existed, or a build behind a service worker that has
 * never heard of it. The server's English is exactly what shipped before any
 * of this, so the mechanism's worst case is the previous behaviour.
 */
function sentence(
  line: string | JobLine,
  t: TFunction,
  i18n: { exists: (key: string) => boolean }
): string {
  if (typeof line === 'string') return line;
  if (line.key === null || !i18n.exists(line.key)) return line.text;
  return t(line.key, { ...line.params });
}

export function JobIssueList({
  title,
  lines,
  note,
  cap = 5,
}: {
  title: string;
  lines: readonly (string | JobLine)[];
  /** One sentence about what the failures mean for the list above them. */
  note?: string;
  cap?: number;
}) {
  const { t, i18n } = useTranslation();
  if (lines.length === 0) return null;
  const { shown, remaining } = capList(
    lines.map((line) => sentence(line, t, i18n)),
    cap
  );

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
