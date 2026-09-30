import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { coveringParentId, entriesToAdd, isParentEntry } from '../../lib/addMembers';
import { type MemberEntry, type MemberKind, memberMatches } from '../../lib/membership';
import { FormSheet } from '../form/FormSheet';
import { PickRow } from './PickRow';

interface GroupAddSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupName: string;
  candidates: readonly MemberEntry[];
  pending: boolean;
  onAdd: (entries: MemberEntry[]) => Promise<void>;
}

const key = (entry: MemberEntry) => `${entry.kind}:${entry.id}`;

// Switch order. A new kind is one entry here plus its strings; the switch,
// hint and footer summary all read this list. The labels carry no count: four
// segments with counts do not fit at 390px, so the count leads the hint.
// Each rule-bearing kind comes before the kind it brings — accounts before
// holdings, payees before bills (SC-1408).
const KINDS: readonly { kind: MemberKind; label: string; hint: string; count: string }[] = [
  {
    kind: 'account',
    label: 'v3.membership.addSheet.accounts',
    hint: 'v3.membership.addSheet.accountsHint',
    count: 'v3.membership.count.account',
  },
  {
    kind: 'holding',
    label: 'v3.membership.addSheet.holdings',
    hint: 'v3.membership.addSheet.holdingsHint',
    count: 'v3.membership.count.holding',
  },
  {
    kind: 'payee',
    label: 'v3.membership.addSheet.payees',
    hint: 'v3.membership.addSheet.payeesHint',
    count: 'v3.membership.count.payee',
  },
  {
    kind: 'bill',
    label: 'v3.membership.addSheet.bills',
    hint: 'v3.membership.addSheet.billsHint',
    count: 'v3.membership.count.bill',
  },
];

/**
 * "Add to <group>" (SC-1411). One step: a group holds accounts AND holdings,
 * so the kind is a switch at the top rather than a filter buried in Refine,
 * and accounts come first — fewer rows, and usually what the user means. A
 * holding whose account is ticked says so and cannot be ticked again, because
 * the account already brings it.
 */
export function GroupAddSheet({
  open,
  onOpenChange,
  groupName,
  candidates,
  pending,
  onAdd,
}: GroupAddSheetProps) {
  const { t, i18n } = useTranslation();
  const [kind, setKind] = useState<MemberKind>('account');
  const [query, setQuery] = useState('');
  const [ticked, setTicked] = useState<Map<string, MemberEntry>>(new Map());

  const counts = useMemo(
    () => new Map(KINDS.map(({ kind: k }) => [k, candidates.filter((e) => e.kind === k).length])),
    [candidates]
  );
  const tickedParentIds = useMemo(
    () => new Set([...ticked.values()].filter(isParentEntry).map((e) => e.id)),
    [ticked]
  );
  const parentNames = useMemo(
    () => new Map(candidates.filter(isParentEntry).map((e) => [e.id, e.label])),
    [candidates]
  );
  const rows = candidates.filter((e) => e.kind === kind && memberMatches(e, query));
  const chosen = entriesToAdd([...ticked.values()]);
  const current = KINDS.find((k) => k.kind === kind);

  const close = (next: boolean) => {
    if (!next) {
      setTicked(new Map());
      setQuery('');
    }
    onOpenChange(next);
  };
  const toggle = (entry: MemberEntry, checked: boolean) => {
    const next = new Map(ticked);
    if (checked) next.set(key(entry), entry);
    else next.delete(key(entry));
    setTicked(next);
  };
  const save = async () => {
    try {
      await onAdd(chosen);
      close(false);
    } catch {
      /* The hook has already shown the error; the selection stays for a retry. */
    }
  };

  return (
    <FormSheet
      open={open}
      onOpenChange={close}
      title={t('v3.membership.addSheet.title', { group: groupName })}
      description={t('v3.membership.addSheet.description')}
      footer={
        <>
          <p className="text-caption text-muted-foreground" aria-live="polite">
            {chosen.length > 0
              ? t('v3.membership.addSheet.summary', {
                  items: new Intl.ListFormat(i18n.language, { type: 'conjunction' }).format(
                    KINDS.flatMap((k) => {
                      const n = chosen.filter((e) => e.kind === k.kind).length;
                      return n > 0 ? [t(k.count, { count: n })] : [];
                    })
                  ),
                })
              : t('v3.membership.addSheet.none')}
          </p>
          <div className="flex flex-col-reverse gap-2 lg:flex-row lg:justify-end">
            <Button variant="ghost" onClick={() => close(false)} disabled={pending}>
              {t('v3.form.cancel')}
            </Button>
            <Button onClick={() => void save()} disabled={pending || chosen.length === 0}>
              {pending
                ? t('v3.membership.adding')
                : t('v3.membership.addSheet.submit', { count: chosen.length })}
            </Button>
          </div>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('v3.membership.addSheet.search')}
          aria-label={t('v3.membership.addSheet.search')}
        />
        <Segmented
          value={kind}
          onValueChange={(next) => setKind(next as MemberKind)}
          aria-label={t('v3.membership.addSheet.kind')}
        >
          {KINDS.map((k) => (
            <SegmentedItem key={k.kind} value={k.kind}>
              {t(k.label)}
            </SegmentedItem>
          ))}
        </Segmented>
        {current ? (
          <p className="flex flex-wrap gap-x-3 text-caption text-muted-foreground">
            <span className="tabular-nums">
              {t(current.count, { count: counts.get(current.kind) ?? 0 })}
            </span>
            <span>{t(current.hint)}</span>
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p className="py-6 text-center text-body text-muted-foreground">
            {t('v3.membership.addSheet.empty')}
          </p>
        ) : (
          <div className="-mx-3 flex flex-col">
            {rows.map((entry) => {
              const via = coveringParentId(entry, tickedParentIds);
              return (
                <PickRow
                  key={key(entry)}
                  id={`add-${key(entry)}`}
                  label={entry.label}
                  sublabel={entry.sublabel}
                  checked={ticked.has(key(entry)) || Boolean(via)}
                  onCheckedChange={(checked) => toggle(entry, checked)}
                  disabledReason={
                    via
                      ? t('v3.membership.addSheet.includedVia', { account: parentNames.get(via) })
                      : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    </FormSheet>
  );
}
