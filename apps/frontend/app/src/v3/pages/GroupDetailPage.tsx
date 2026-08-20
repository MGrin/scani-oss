import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { Textarea } from '@scani/ui/ui/textarea';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block, BlockHeader } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { StatTile } from '@scani/ui/v3/components/charts/StatTile';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { ArrowLeft, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import { optimisticPatchGroup, optimisticRemoveGroups } from '@/v3/hooks/optimisticUpdates';
import { Field } from '../components/form/Field';
import { GroupColorChoice } from '../components/groups/GroupColorChoice';
import { MemberList } from '../components/membership/MemberList';
import { MemberPicker } from '../components/membership/MemberPicker';
import { useGroupMembership } from '../hooks/useGroupMembership';
import {
  GROUP_ACCOUNT_NOTE_KEY,
  groupAmount,
  groupCoverageLine,
  groupValuesById,
  inactiveGroupNote,
  unpricedGroupNote,
} from '../lib/groups';
import { countOfKind, inactiveMemberCount, memberCountLine } from '../lib/membership';
import { V3_ROUTES } from '../lib/routes';

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
  const groupValue = groupValuesById(valuesQuery.data?.groups ?? []).get(id);

  const membership = useGroupMembership(id);
  const [adding, setAdding] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [draft, setDraft] = useState<{ name: string; description: string; color: string } | null>(
    null
  );

  const updateGroup = trpc.groups.update.useMutation({
    onMutate: ({ id: groupId, data }) =>
      optimisticPatchGroup(utils, groupId, {
        name: data.name,
        color: data.color,
        description: data.description,
      }),
    onSuccess: () => {
      setDraft(null);
      showSuccess(t('v3.groups.detail.toast.updated'));
    },
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      showError(error, t('v3.groups.detail.toast.updating'));
    },
    onSettled: () => void invalidatePortfolioQueries(utils),
  });

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
        <BackLink />
        <Skeleton className="h-40 w-full" aria-hidden="true" />
      </PageLayout>
    );
  }

  if (!group) {
    return (
      <PageLayout measure="wide">
        <BackLink />
        <p className="text-body text-muted-foreground">{t('v3.groups.detail.notFound')}</p>
      </PageLayout>
    );
  }

  // The draft only exists once something has been typed, so the form shows the
  // record until then and "dirty" needs no separate flag.
  const current = draft ?? {
    name: group.name,
    description: group.description ?? '',
    color: group.color,
  };
  const dirty =
    current.name !== group.name ||
    current.description !== (group.description ?? '') ||
    current.color !== group.color;
  const nameIsEmpty = current.name.trim().length === 0;

  const patch = (change: Partial<typeof current>) => setDraft({ ...current, ...change });

  const hasAccountMembers = membership.members.some((member) => member.kind === 'account');
  const unpriced = unpricedGroupNote(groupValue?.unpricedSymbols ?? [], t);
  // Null rather than 0 while the list is still arriving: "covers 22 of the 0
  // listed below" is a worse sentence than the one this replaced.
  const listedHoldings = membership.isLoading ? null : countOfKind(membership.members, 'holding');
  const inactive = inactiveGroupNote(inactiveMemberCount(membership.members), t);

  return (
    <PageLayout measure="wide">
      <BackLink />

      <Block className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-3 shrink-0 rounded-full"
              style={{ backgroundColor: current.color }}
            />
            <h1 className="min-w-0 truncate text-title">{group.name}</h1>
          </div>
          <p className="text-caption text-muted-foreground">
            {memberCountLine(membership.members, t)}
          </p>
        </div>

        {valuesQuery.isLoading ? (
          <Skeleton className="h-12 w-48" aria-hidden="true" />
        ) : (
          <StatTile
            emphasis="hero"
            label={t('v3.groups.detail.value')}
            value={
              <Numeric
                value={groupAmount(groupValue)}
                currency={valuesQuery.data?.baseCurrency ?? 'USD'}
              />
            }
          />
        )}

        <div className="flex flex-col gap-1 text-caption text-muted-foreground">
          <p>{groupCoverageLine(groupValue, listedHoldings, t)}</p>
          {/* The two reasons the figure covers fewer rows than the list shows,
           *  together and directly under the sentence that states the gap. */}
          {inactive ? <p>{inactive}</p> : null}
          {unpriced ? <p>{unpriced}</p> : null}
          {/* Said only where it can bite: on a group with no account in it the
           *  sentence explains a mechanism the reader cannot see. */}
          {hasAccountMembers ? <p>{t(GROUP_ACCOUNT_NOTE_KEY)}</p> : null}
        </div>
      </Block>

      <Block>
        <BlockHeader title={t('v3.groups.detail.inThisGroup')} />
        {membership.isLoading ? (
          <Skeleton className="mx-4 mb-4 h-24" aria-hidden="true" />
        ) : membership.members.length > 0 ? (
          <MemberList
            members={membership.members}
            pendingIds={membership.pendingIds}
            onRemove={membership.remove}
            removeLabel={(entry) =>
              t('v3.groups.detail.removeMember', { label: entry.label, group: group.name })
            }
          />
        ) : (
          <p className="px-4 pb-4 text-body text-muted-foreground">{t('v3.groups.detail.empty')}</p>
        )}

        {adding ? (
          <div className="border-border border-t">
            <MemberPicker
              candidates={membership.candidates}
              pendingIds={membership.pendingIds}
              onAdd={membership.add}
              onDone={() => setAdding(false)}
              noun={t('v3.groups.detail.noun')}
              note={t('v3.groups.detail.note')}
            />
          </div>
        ) : (
          <div className="px-4 pt-3 pb-4">
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus className="mr-2 size-4" aria-hidden="true" />
              {t('v3.groups.detail.addMembers')}
            </Button>
          </div>
        )}
      </Block>

      <Block>
        <BlockHeader title={t('v3.groups.detail.details')} />
        <div className="flex flex-col gap-3 border-border border-t p-4">
          <Field label={t('v3.groups.detail.name')} htmlFor="group-name">
            <Input
              id="group-name"
              value={current.name}
              onChange={(event) => patch({ name: event.target.value })}
              disabled={updateGroup.isPending}
            />
          </Field>
          <Field label={t('v3.groups.detail.description')} htmlFor="group-description">
            <Textarea
              id="group-description"
              value={current.description}
              onChange={(event) => patch({ description: event.target.value })}
              maxLength={200}
              rows={2}
              disabled={updateGroup.isPending}
            />
          </Field>
          <Field label={t('v3.groups.detail.colour')}>
            <GroupColorChoice
              value={current.color}
              onChange={(color) => patch({ color })}
              disabled={updateGroup.isPending}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              disabled={!dirty || nameIsEmpty || updateGroup.isPending}
              onClick={() =>
                updateGroup.mutate({
                  id,
                  data: {
                    name: current.name.trim(),
                    color: current.color,
                    description: current.description.trim() || null,
                  },
                })
              }
            >
              {t('v3.groups.detail.saveChanges')}
            </Button>
            {dirty ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={updateGroup.isPending}
                onClick={() => setDraft(null)}
              >
                {t('v3.groups.detail.discard')}
              </Button>
            ) : null}
            {/* §7: say what is missing rather than leaving a pale button to be
             *  interpreted — the gap QA 10.1 flagged on the wizard's Next. */}
            {nameIsEmpty ? (
              <p className="text-caption text-muted-foreground">{t('v3.groups.detail.needName')}</p>
            ) : null}
          </div>
        </div>
      </Block>

      <Block>
        <BlockHeader title={t('v3.groups.detail.dangerZone')} />
        <div className="p-4">
          <ConfirmAction
            label={t('v3.groups.detail.deleteTrigger')}
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

function BackLink() {
  const { t } = useTranslation();
  return (
    <Button variant="ghost" size="sm" asChild className="-ml-2 self-start">
      <Link to={V3_ROUTES.groups}>
        <ArrowLeft className="mr-2 size-4" aria-hidden="true" />
        {t('v3.groups.detail.backToGroups')}
      </Link>
    </Button>
  );
}
