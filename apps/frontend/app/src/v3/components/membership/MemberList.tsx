import { Button } from '@scani/ui/ui/button';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { X } from 'lucide-react';
import type { MemberEntry } from '../../lib/membership';

/**
 * What is in the record right now, each row carrying its own way out.
 *
 * This list reads *first* and is visually distinct from the picker below it,
 * which is the correction this ticket is about: v2 showed one flat checkbox
 * list in which "in the group" and "exists in your portfolio" were the same
 * row in two tick states, so the question an editor opens the screen to ask —
 * what is in here? — could only be answered by reading every checkbox.
 *
 * Remove is a direct action, not a checkbox you commit later, and it is
 * deliberately NOT confirmed and NOT painted destructive. `ConfirmAction`'s
 * rule (V3-31) reserves red for writes with no inverse; taking a holding out
 * of a group deletes nothing and its inverse is one tap away in the picker
 * directly below. A confirmation here would cost two taps on the app's most
 * routine edit to protect against an action that undoes itself.
 *
 * **The two kinds are not peers, and the list says so.** A holding's
 * membership is the primitive — it is a `holding_groups` row. An account's is
 * a cache the backend rebuilds with the rule *every visible holding in this
 * account is in the group*, so an account row appears on its own the moment
 * its last holding goes in, and removing it takes every one of its holdings
 * out. Listing the two in one undifferentiated run is what would make that
 * read as a bug; two titled runs plus the note below make it a rule.
 */

interface MemberListProps {
  members: readonly MemberEntry[];
  pendingIds: ReadonlySet<string>;
  onRemove: (entry: MemberEntry) => void;
  /** Names what leaving the record means for this surface. */
  removeLabel: (entry: MemberEntry) => string;
}

function entryKey(entry: MemberEntry): string {
  return `${entry.kind}:${entry.id}`;
}

function Run({
  title,
  note,
  entries,
  pendingIds,
  onRemove,
  removeLabel,
}: MemberListProps & { title: string; note?: string; entries: readonly MemberEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <>
      <div className="border-border border-t px-4 pt-3 pb-1">
        <h3 className="text-label text-muted-foreground">{title}</h3>
        {note ? <p className="text-caption text-muted-foreground">{note}</p> : null}
      </div>
      <DataRowList>
        {entries.map((entry) => {
          const pending = pendingIds.has(entryKey(entry));
          return (
            <DataRow
              key={entryKey(entry)}
              label={entry.label}
              sublabel={entry.sublabel}
              value={
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => onRemove(entry)}
                  aria-label={removeLabel(entry)}
                >
                  <X className="size-4" aria-hidden="true" />
                  <span className="ml-1.5">{pending ? 'Removing' : 'Remove'}</span>
                </Button>
              }
            />
          );
        })}
      </DataRowList>
    </>
  );
}

export function MemberList(props: MemberListProps) {
  const { members } = props;
  return (
    <>
      <Run
        {...props}
        title="Holdings"
        entries={members.filter((entry) => entry.kind === 'holding')}
      />
      <Run
        {...props}
        title="Whole accounts"
        note="Listed once every holding in the account is in the group. Removing one takes all of them out."
        entries={members.filter((entry) => entry.kind === 'account')}
      />
    </>
  );
}
