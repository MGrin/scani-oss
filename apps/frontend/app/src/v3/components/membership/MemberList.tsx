import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { DataRow, DataRowList } from '@scani/ui/v3/components/DataRow';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { countOfKind, type MemberEntry } from '../../lib/membership';

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
 * **The two kinds are not peers, and the list says so.** An account row is a
 * STANDING RULE (SC-386): the account is in the group, and so is everything it
 * holds now or receives later. A holding row is one position. So the two are
 * not the same claim at different sizes — removing the account ends the rule
 * and takes all of it out, while removing a holding that is only in by that
 * rule leaves the rule standing and takes that one position out of it. That
 * second action is what makes the rule usable in a wallet receiving airdrops
 * continuously, and it is one tap on the row where the junk is visible.
 * Listing the two in one undifferentiated run would hide the difference; two
 * titled runs plus the note below make it a rule.
 *
 * **Each run carries its own count, and nothing carries their sum** (SC-388).
 * The section above this used to be titled "In this group (46)" over a group of
 * 36 holdings and 10 accounts — a number in a unit no other figure on the page
 * uses, printed directly above 36 rows, and not a count of positions either
 * since each of those accounts brings holdings already among the 36. A count
 * belongs to one kind of thing, so it is written on the run of that thing.
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
  const { t } = useTranslation();
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
              label={
                entry.inactive ? (
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{entry.label}</span>
                    {/* The row the group's total does not count, marked where
                     *  the reader meets it. The sentence beside the figure says
                     *  how many there are; without this there is no way to tell
                     *  WHICH, and the holdings list badges the same position in
                     *  the same words. */}
                    <Badge variant="secondary" className="shrink-0">
                      {t('v3.holdings.peek.inactive')}
                    </Badge>
                  </span>
                ) : (
                  entry.label
                )
              }
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
                  <span className="ms-1.5">
                    {pending ? t('v3.membership.removePending') : t('v3.membership.removeAction')}
                  </span>
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
  const { t } = useTranslation();
  const { members } = props;
  return (
    <>
      <Run
        {...props}
        title={t('v3.membership.holdings', { count: countOfKind(members, 'holding') })}
        entries={members.filter((entry) => entry.kind === 'holding')}
      />
      <Run
        {...props}
        title={t('v3.membership.wholeAccounts', { count: countOfKind(members, 'account') })}
        note={t('v3.membership.wholeAccountsNote')}
        entries={members.filter((entry) => entry.kind === 'account')}
      />
    </>
  );
}
