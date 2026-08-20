import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { Check, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type MemberEntry, memberMatches } from '../../lib/membership';

/**
 * The *add* half of membership editing: search what is not in the record yet,
 * and put one thing in with one tap.
 *
 * Inline, on the surface that owns the record — never an overlay. The reasoning
 * is V3-31's, applied to a constructive action instead of a destructive one: a
 * Radix dialog opened over a page is a second surface with its own dismiss, and
 * a picker is the one place a reader is most likely to change their mind
 * mid-gesture. Inline, "I'm done adding" is the same Done button that opened
 * it, and the members list is still on screen behind — which matters, because
 * the question a person actually asks while adding is "is it in already?".
 *
 * Adding applies immediately rather than accumulating a selection to commit.
 * That is what removes the Save button, and with it the whole class of bug this
 * ticket started from: an action that cannot be pushed off the screen is one
 * that cannot be lost. The inverse of an add is a remove, one tap away in the
 * list above, so nothing here needs a confirmation step.
 */

interface MemberPickerProps {
  candidates: readonly MemberEntry[];
  /** The rows currently being written, so each can show its own progress
   *  rather than the whole list greying out. */
  pendingIds: ReadonlySet<string>;
  onAdd: (entry: MemberEntry) => void;
  onDone: () => void;
  /** "holdings and accounts" for a group, "holdings" for a vault. */
  noun: string;
  /** One line about what adding does, where that is not obvious — adding a
   *  whole account adds every holding in it. */
  note?: string;
}

function entryKey(entry: MemberEntry): string {
  return `${entry.kind}:${entry.id}`;
}

export function MemberPicker({
  candidates,
  pendingIds,
  onAdd,
  onDone,
  noun,
  note,
}: MemberPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');

  const matches = useMemo(
    () => candidates.filter((entry) => memberMatches(entry, query)),
    [candidates, query]
  );

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="relative">
        <Search
          className="-translate-y-1/2 absolute top-1/2 left-3 size-4 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('v3.membership.searchPlaceholder', { noun })}
          aria-label={t('v3.membership.searchLabel', { noun })}
          className="pl-9"
        />
      </div>

      {note ? <p className="text-caption text-muted-foreground">{note}</p> : null}

      {matches.length > 0 ? (
        <DataRowList className="rounded-md border border-border">
          {matches.map((entry) => {
            const pending = pendingIds.has(entryKey(entry));
            return (
              <DataRow
                key={entryKey(entry)}
                label={entry.label}
                sublabel={entry.sublabel}
                value={
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => onAdd(entry)}
                    aria-label={t('v3.membership.add', { label: entry.label })}
                  >
                    {pending ? (
                      <Check className="size-4" aria-hidden="true" />
                    ) : (
                      <Plus className="size-4" aria-hidden="true" />
                    )}
                    <span className="ml-1.5">
                      {pending ? t('v3.membership.addPending') : t('v3.membership.addAction')}
                    </span>
                  </Button>
                }
              />
            );
          })}
        </DataRowList>
      ) : (
        // Two different sentences, because they need two different next
        // actions — the house rule from §7 of the design brief.
        <p className="text-body text-muted-foreground">
          {query.trim()
            ? t('v3.membership.noMatch', { query: query.trim() })
            : t('v3.membership.allAdded', { noun })}
        </p>
      )}

      <div>
        <Button variant="ghost" size="sm" onClick={onDone}>
          {t('v3.membership.picker.done')}
        </Button>
      </div>
    </div>
  );
}
