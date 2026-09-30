import { Badge } from '@scani/ui/ui/badge';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { EmptyStateSpec } from '@scani/ui/v3/lib/data-view';
import { CircleMinus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  compareMembers,
  countOfKind,
  MEMBER_KINDS,
  type MemberEntry,
  type MemberKind,
  memberMatches,
} from '../../lib/membership';

const KIND_LABEL_KEY: Record<MemberKind, string> = {
  holding: 'v3.membership.holdings',
  account: 'v3.membership.wholeAccounts',
  bill: 'v3.membership.bills',
  payee: 'v3.membership.payees',
};

/** What a rule-carrying member stands for, said in its peek. */
const KIND_NOTE_KEY: Partial<Record<MemberKind, string>> = {
  account: 'v3.membership.wholeAccountsNote',
  payee: 'v3.membership.payeeNote',
};

interface MemberListProps {
  members: readonly MemberEntry[];
  /** The page's own path; a member's peek opens at `<basePath>/<member>`. */
  basePath: string;
  pendingIds: ReadonlySet<string>;
  onRemove: (entry: MemberEntry) => void;
  onRemoveMany?: (entries: MemberEntry[]) => Promise<void>;
  removeLabel: (entry: MemberEntry) => string;
  /** The page's empty state, with its add action (UI standard rule 8). */
  empty: EmptyStateSpec;
}

/** Remove, confirmed — the danger trigger every other list's peek uses. */
function RemoveMemberAction({
  label,
  consequence,
  isPending,
  onConfirm,
}: {
  label: string;
  consequence: string;
  isPending: boolean;
  onConfirm: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <ConfirmAction
      label={
        <>
          <CircleMinus className="me-2 size-4" aria-hidden="true" />
          {label}
        </>
      }
      triggerClassName="text-destructive hover:text-destructive"
      confirmLabel={t('v3.membership.confirmRemove')}
      destructive
      open={open}
      onOpenChange={setOpen}
      isPending={isPending}
      consequence={consequence}
      onConfirm={() => {
        onConfirm().then(
          () => setOpen(false),
          () => {
            /* The mutation reports the error; keep the confirmation open. */
          }
        );
      }}
    />
  );
}

export function MemberList({
  members,
  basePath,
  pendingIds,
  onRemove,
  onRemoveMany,
  removeLabel,
  empty,
}: MemberListProps) {
  const { t } = useTranslation();
  const label = (e: MemberEntry) => (
    <span>
      {e.label} {e.inactive && <Badge variant="secondary">{t('v3.holdings.peek.inactive')}</Badge>}
    </span>
  );
  // Under the figure, in the row's value zone: inline in the subtitle they
  // clipped it to "Wise…" at 390px (SC-1404).
  // One badge per row: a direct member that an account rule also brings in
  // says both in one pill, not two stacked ones.
  const badges = (e: MemberEntry) =>
    e.membership ? (
      <Badge variant="outline">
        {e.inherited && e.membership === 'direct'
          ? t('v3.membership.directAndInherited')
          : t(`v3.membership.${e.membership}`)}
      </Badge>
    ) : null;
  const figure = (e: MemberEntry) =>
    e.figure ? <Numeric value={e.figure.value} currency={e.figure.currency} /> : null;
  const removeAll = async (entries: MemberEntry[]) => {
    if (onRemoveMany) await onRemoveMany(entries);
    else for (const e of entries) onRemove(e);
  };
  const kindLabel = (kind: MemberKind) =>
    t(KIND_LABEL_KEY[kind], { count: countOfKind(members, kind) });

  return (
    <V3DataView
      getId={(row) => row.id}
      config={{
        pageKey: 'group-members',
        data: members.map((entry) => ({
          ...entry,
          id: `${entry.kind}:${entry.id}`,
          member: entry,
        })),
        nounKey: 'ui.dataView.noun.reviewItems',
        searchPlaceholderKey: 'ui.dataView.accounts.config.search',
        searchFn: (row, q) => memberMatches(row.member, q),
        filterDefs: [
          {
            key: 'kind',
            labelKey: 'ui.dataView.members.filter.kind',
            options: MEMBER_KINDS.filter((kind) => countOfKind(members, kind) > 0).map((kind) => ({
              value: kind,
              label: kindLabel(kind),
            })),
            fn: (row, value) => row.kind === value,
          },
        ],
        sortDefs: [{ key: 'name', labelKey: 'ui.dataView.members.col.member' }],
        defaultSort: { field: 'name', direction: 'asc' },
        sortFn: (a, b, _field, direction) =>
          compareMembers(a.member, b.member) * (direction === 'asc' ? 1 : -1),
        renderRow: (row) => ({
          label: label(row.member),
          ariaLabel: row.label,
          sublabel: row.member.sublabel,
          value: figure(row.member),
          delta: badges(row.member),
        }),
        columns: [
          {
            key: 'holding',
            headerKey: 'ui.dataView.members.col.member',
            render: (row) => (
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-label">{label(row.member)}</span>
                <span className="truncate text-caption text-muted-foreground">
                  {row.member.sublabel}
                </span>
              </span>
            ),
          },
          {
            key: 'value',
            headerKey: 'ui.dataView.holdings.col.value',
            numeric: true,
            render: (row) => figure(row.member),
          },
          {
            key: 'membership',
            headerKey: 'ui.dataView.members.col.membership',
            render: (row) => badges(row.member),
          },
        ],
        peek: {
          basePath,
          render: (row) => ({
            title: row.member.label,
            subtitle: row.member.sublabel,
            primary: [],
            content: KIND_NOTE_KEY[row.member.kind] ? (
              <p className="text-caption text-muted-foreground">
                {t(KIND_NOTE_KEY[row.member.kind] ?? '')}
              </p>
            ) : undefined,
            actions: (
              <RemoveMemberAction
                label={removeLabel(row.member)}
                consequence={t('v3.membership.removeSelection', { count: 1 })}
                isPending={pendingIds.has(row.id)}
                onConfirm={() => removeAll([row.member])}
              />
            ),
          }),
        },
        empty,
        renderBulkActions: (ids, clear) => (
          <RemoveMemberAction
            label={`${t('v3.membership.removeAction')} (${ids.size})`}
            consequence={t('v3.membership.removeSelection', { count: ids.size })}
            isPending={pendingIds.size > 0}
            onConfirm={async () => {
              await removeAll(members.filter((e) => ids.has(`${e.kind}:${e.id}`)));
              clear();
            }}
          />
        ),
      }}
    />
  );
}
