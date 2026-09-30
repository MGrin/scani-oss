import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Button } from '@scani/ui/ui/button';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { StatTile } from '@scani/ui/v3/components/charts/StatTile';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { Plus, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import { optimisticRemoveGroups } from '@/v3/hooks/optimisticUpdates';
import { BackLink } from '../components/BackLink';
import { EditAction } from '../components/form/FormSheet';
import { EditGroupSheet } from '../components/groups/EditGroupSheet';
import { GroupAddSheet } from '../components/membership/GroupAddSheet';
import { MemberList } from '../components/membership/MemberList';
import { GroupBillsTotal } from '../components/money/GroupBillsTotal';
import { useGroupMembership } from '../hooks/useGroupMembership';
import {
  allInactiveGroupAmount,
  GROUP_ACCOUNT_NOTE_KEY,
  groupAmount,
  groupCoverageLine,
  groupValuesById,
  inactiveGroupNote,
  unpricedGroupNote,
} from '../lib/groups';
import { countOfKind, inactiveMemberCount, memberCountLine } from '../lib/membership';
import { groupDetailPath, V3_ROUTES } from '../lib/routes';

/**
 * One group: what is in it, and how to change that.
 *
 * A **page**, not a peek, by the rule V3-15 settled: a record peeks when it is
 * a name, a figure and three or four facts, and gets a page when it carries a
 * screen's worth of interaction. A group's whole substance is an editable
 * member list, which is exactly why vaults already went this way. Making the
 * two the same shape is the point — SC-70 was reported against groups and
 * vaults have identical mechanics, so they get identical surfaces.
 *
 * What this replaces is v2's three-step wizard (`GroupFormDialog`), and the
 * reasons are two. The user-visible one: a wizard is right for *creating*
 * something and wrong for editing it, because editing a group is almost always
 * one small change and a wizard makes you walk the whole flow to make it. The
 * structural one: that dialog is a v2 component laid out for a desktop dialog,
 * and at 390px its primary action left the screen entirely (see the note in
 * `v3-tokens.css`). A surface with no Save button cannot lose its Save button.
 *
 * Details still commit on a button, because a text field has no other honest
 * commit point — a name that saves per keystroke writes nine groups called
 * "R", "Re", "Ret". Membership does not: it applies on the tap.
 *
 * **The top card is what the group is worth** (SC-87). The page this replaced
 * shipped with no figure on it at all — three blocks of counts and controls —
 * and a group is a bucket of money the user defined himself, so "how much is in
 * it" is the first question the surface has to answer. The figure is stated
 * with what it covers, because two things about it are not self-evident: an
 * account in a group contributes through its own holdings rather than as a
 * thing of its own, and a position we cannot price is unknown rather than zero.
 *
 * **Three counts used to render here and no two of them agreed** (SC-388): a
 * header reading "36 holdings · 10 accounts", a section titled "In this group
 * (46)" over a list of 36, and a figure explained as "the 22 active holdings in
 * this group". They were counting three different things and only the first
 * said which. So every number on this page now names its own set — the runs of
 * the list count themselves, nothing prints their sum, and the figure states
 * both what it covers and what it leaves out. That is a labelling change and
 * not a membership one: `GroupValuationService` still resolves who is in this
 * group exactly once (SC-385/386), and none of these figures moved.
 */
export function GroupDetailPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const groupsQuery = trpc.groups.getAllWithCounts.useQuery();
  const valuesQuery = trpc.groups.getValues.useQuery();
  const group = groupsQuery.data?.find((candidate) => candidate.id === id);
  useDocumentTitle(group?.name ?? t('v3.groups.page.title'));
  const groupValue = groupValuesById(valuesQuery.data?.groups ?? []).get(id);

  const membership = useGroupMembership(id);
  const [adding, setAdding] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const deleteGroup = trpc.groups.delete.useMutation({
    onMutate: ({ id: groupId }) => optimisticRemoveGroups(utils, [groupId]),
    onSuccess: () => {
      showSuccess(t('v3.groups.detail.toast.deleted'));
      navigate(V3_ROUTES.groups, { replace: true });
    },
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      showError(error, t('v3.groups.detail.toast.deleting'));
    },
    onSettled: () => void invalidatePortfolioQueries(utils),
  });

  if (!id) return null;

  if (groupsQuery.isLoading) {
    return (
      <PageLayout measure="wide">
        <BackLink to={V3_ROUTES.groups} label={t('v3.groups.detail.backToGroups')} />
        <Skeleton className="h-40 w-full" aria-hidden="true" />
      </PageLayout>
    );
  }

  if (!group) {
    return (
      <PageLayout measure="wide">
        <BackLink to={V3_ROUTES.groups} label={t('v3.groups.detail.backToGroups')} />
        <p className="text-body text-muted-foreground">{t('v3.groups.detail.notFound')}</p>
      </PageLayout>
    );
  }

  const hasAccountMembers = membership.members.some((member) => member.kind === 'account');
  const unpriced = unpricedGroupNote(groupValue?.unpricedSymbols ?? [], t);
  // Null rather than 0 while the list is still arriving: "covers 22 of the 0
  // listed below" is a worse sentence than the one this replaced.
  const listedHoldings = membership.isLoading ? null : countOfKind(membership.members, 'holding');
  const inactive = inactiveGroupNote(inactiveMemberCount(membership.members), t);
  // Every holding inactive: headline what they are worth under a label that
  // says so, as the holdings list does (SC-1122, SC-1128). The inactive-count
  // sentence would then restate the whole group, so it gives way to one line.
  const allInactiveAmount = allInactiveGroupAmount(groupValue);
  const allInactive = allInactiveAmount !== null;
  // Bills carry no value, so a group of only bills headlined "$0.00 · nothing
  // in this group carries a value" read as broken (SC-1408). It leads with what
  // its bills commit instead, in the Bills page's own figure and words.
  const hasValued =
    countOfKind(membership.members, 'holding') + countOfKind(membership.members, 'account') > 0;
  const hasBills =
    countOfKind(membership.members, 'bill') + countOfKind(membership.members, 'payee') > 0;
  const billsOnly = !membership.isLoading && hasBills && !hasValued;

  return (
    <PageLayout measure="wide">
      <BackLink to={V3_ROUTES.groups} label={t('v3.groups.detail.backToGroups')} />

      <Block className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-3 shrink-0 rounded-full"
              style={{ backgroundColor: group.color }}
            />
            <h1 className="min-w-0 truncate text-title">{group.name}</h1>
          </div>
          <p className="text-caption text-muted-foreground">
            {memberCountLine(membership.members, t)}
          </p>
        </div>

        {billsOnly ? (
          <GroupBillsTotal groupId={id} emphasis="hero" />
        ) : (
          <>
            {valuesQuery.isLoading ? (
              <Skeleton className="h-12 w-48" aria-hidden="true" />
            ) : (
              <StatTile
                emphasis="hero"
                label={t(
                  allInactive ? 'v3.holdings.summary.inactiveValue' : 'v3.groups.detail.value'
                )}
                value={
                  <Numeric
                    value={allInactive ? allInactiveAmount : groupAmount(groupValue)}
                    currency={valuesQuery.data?.baseCurrency ?? 'USD'}
                  />
                }
              />
            )}

            <div className="flex flex-col gap-1 text-caption text-muted-foreground">
              <p>
                {allInactive
                  ? t('v3.holdings.summary.allInactive')
                  : groupCoverageLine(groupValue, listedHoldings, t)}
              </p>
              {/* The two reasons the figure covers fewer rows than the list shows,
               *  together and directly under the sentence that states the gap. */}
              {inactive && !allInactive ? <p>{inactive}</p> : null}
              {unpriced ? <p>{unpriced}</p> : null}
              {/* Said only where it can bite: on a group with no account in it the
               *  sentence explains a mechanism the reader cannot see. */}
              {hasAccountMembers ? <p>{t(GROUP_ACCOUNT_NOTE_KEY)}</p> : null}
            </div>
          </>
        )}
        {hasBills && !billsOnly ? <GroupBillsTotal groupId={id} emphasis="default" /> : null}

        <div className="self-start">
          <EditAction onClick={() => setEditingDetails(true)} />
        </div>
      </Block>

      {/* The list sits on the page like every other list, not inside a card:
       *  its toolbar is page-coloured and read as a band inside one (SC-1404). */}
      <section className="flex flex-col gap-3" aria-labelledby="group-members-heading">
        {/* The section's action sits beside its heading, never in the list
         *  toolbar (UI standard rule 1–2, SC-1411). */}
        <div className="flex items-center justify-between gap-3">
          <h2 id="group-members-heading" className="text-title">
            {t('v3.groups.detail.inThisGroup')}
          </h2>
          {membership.members.length > 0 ? (
            // The short label keeps the section heading readable at 390px; the
            // full sentence stays the accessible name.
            <Button
              variant="outline"
              size="sm"
              aria-label={t('v3.groups.detail.addMembers')}
              onClick={() => setAdding(true)}
            >
              <Plus className="me-1.5 size-4" aria-hidden="true" />
              {t('v3.membership.addAction')}
            </Button>
          ) : null}
        </div>

        {membership.isLoading ? (
          <Skeleton className="h-24" aria-hidden="true" />
        ) : (
          <MemberList
            members={membership.members}
            basePath={groupDetailPath(group.id)}
            pendingIds={membership.pendingIds}
            onRemove={membership.remove}
            onRemoveMany={membership.removeMany}
            removeLabel={(entry) =>
              t('v3.groups.detail.removeMember', { label: entry.label, group: group.name })
            }
            empty={{
              icon: Users,
              titleKey: 'ui.dataView.groupMembers.empty.title',
              descriptionKey: 'ui.dataView.groupMembers.empty.description',
              action: (
                <Button onClick={() => setAdding(true)}>
                  <Plus className="me-1.5 size-4" aria-hidden="true" />
                  {t('v3.groups.detail.addMembers')}
                </Button>
              ),
            }}
          />
        )}
      </section>

      <GroupAddSheet
        open={adding}
        onOpenChange={setAdding}
        groupName={group.name}
        candidates={membership.candidates}
        pending={membership.pendingIds.size > 0}
        onAdd={membership.add}
      />

      <EditGroupSheet group={group} open={editingDetails} onOpenChange={setEditingDetails} />

      <Block>
        <BlockHeader title={t('v3.groups.detail.dangerZone')} />
        <div className="p-4">
          <ConfirmAction
            label={
              <>
                <Trash2 className="me-2 size-4" aria-hidden="true" />
                {t('v3.groups.detail.deleteTrigger')}
              </>
            }
            triggerClassName="text-destructive hover:text-destructive"
            confirmLabel={t('v3.groups.detail.deleteCommit')}
            destructive
            open={confirmingDelete}
            onOpenChange={setConfirmingDelete}
            isPending={deleteGroup.isPending}
            onConfirm={() => deleteGroup.mutate({ id })}
            consequence={t('v3.groups.detail.deleteConsequence', {
              name: group.name,
              members: memberCountLine(membership.members, t),
            })}
          />
        </div>
      </Block>
    </PageLayout>
  );
}
