import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { showSuccess } from '@scani/ui/ui/use-toast';
import { describeQueryError, type ErrorVerb } from '@scani/ui/v3/lib/errors';
import { Check, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import {
  createAndAssignBlockers,
  describeAssignment,
  groupAssignmentDiff,
  isEmptyDiff,
} from '../../lib/assign-groups';
import { Field } from '../form/Field';
import { FormActions, FormSheet } from '../form/FormSheet';
import { GROUP_COLORS, GroupColorChoice } from './GroupColorChoice';

/**
 * Put a batch of holdings or accounts into groups.
 *
 * Opened from either bulk bar, and the last v2 component two v3 pages rendered
 * (SC-320 phase 3). Three things about v2's version are corrected here rather
 * than carried across:
 *
 * - **A row was a `<button>` wrapping a Radix `Checkbox`, which is itself a
 *   `<button role="checkbox">.`** Interactive inside interactive: axe calls it
 *   `nested-interactive`, a screen reader gets two controls for one choice, and
 *   the inner one is 16px. The row is now one `role="checkbox"` button, drawing
 *   its own box — the same trade `GroupColorChoice` makes for its radios, and
 *   for the same reason (the token layer's coarse-pointer floor keys off
 *   `button`).
 * - **It stayed mounted with the last selection still checked.** Both pages
 *   held it open behind `open={target !== null}`, and nothing reset the checked
 *   set on close; the pre-check effect only fires once `getCommonGroups` has
 *   answered for the *new* selection. So reopening on a different batch showed
 *   the previous batch's groups ticked, over a diff baseline of nothing — and a
 *   Save in that window added those groups to rows that were never in them.
 *   Mounted only while targeted now, which is the reason already written beside
 *   `ApyConfigDialog` on `HoldingsPage`, and the list waits for its own query.
 * - **The failure went to a toast** that opens "Something went wrong" over the
 *   tab bar for four seconds. It is a line under the button now, like every
 *   other v3 form.
 *
 * The save itself is unchanged and must stay so: a diff, never a replace. See
 * `lib/assign-groups.ts`.
 */

interface AssignGroupsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: 'holdings' | 'accounts';
  entityIds: string[];
}

interface GroupOption {
  id: string;
  name: string;
  color: string;
}

/**
 * The checkable list, as a component of its own so it is reachable from a test:
 * `FormSheet` is a Radix dialog and Radix renders nothing at all under
 * `renderToStaticMarkup`.
 */
export function GroupChecklist({
  groups,
  selectedIds,
  onToggle,
  disabled,
}: {
  groups: readonly GroupOption[];
  selectedIds: ReadonlySet<string>;
  onToggle: (groupId: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col">
      {groups.map((group) => {
        const checked = selectedIds.has(group.id);
        return (
          // biome-ignore lint/a11y/useSemanticElements: a native input[type=checkbox] is outside the token layer's coarse-pointer 44px rule (v3-tokens.css keys it off `button`), and nesting one inside the row button is the nested-interactive defect this rewrite exists to remove
          <button
            key={group.id}
            type="button"
            role="checkbox"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onToggle(group.id)}
            className={cn(
              'flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors duration-fast',
              'hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              'disabled:pointer-events-none disabled:opacity-50'
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded border transition-colors duration-fast',
                checked
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border-strong'
              )}
            >
              {checked ? <Check className="size-3.5" /> : null}
            </span>
            <span
              aria-hidden="true"
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: group.color }}
            />
            <span className="min-w-0 truncate text-body">{group.name}</span>
          </button>
        );
      })}
    </div>
  );
}

export function AssignGroupsSheet({
  open,
  onOpenChange,
  entityType,
  entityIds,
}: AssignGroupsSheetProps) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const isHoldings = entityType === 'holdings';

  const allGroupsQuery = trpc.groups.getAll.useQuery();

  const holdingCommon = trpc.holdings.getCommonGroups.useQuery(
    { holdingIds: entityIds },
    { enabled: open && isHoldings && entityIds.length > 0 }
  );
  const accountCommon = trpc.accounts.getCommonGroups.useQuery(
    { accountIds: entityIds },
    { enabled: open && !isHoldings && entityIds.length > 0 }
  );
  const commonGroups = isHoldings ? holdingCommon.data : accountCommon.data;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string>(GROUP_COLORS[0]);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (commonGroups) setSelectedIds(new Set(commonGroups.map((group) => group.id)));
  }, [commonGroups]);

  const fail = (error: unknown, subject: string, verb: ErrorVerb) => {
    const copy = describeQueryError(error, subject, verb);
    setFailure(`${copy.title}. ${copy.detail}`);
  };

  const holdingAssign = trpc.holdings.bulkAssignGroups.useMutation({
    onError: (error) => fail(error, t('v3.groups.assign.subject'), 'save'),
  });
  const accountAssign = trpc.accounts.bulkAssignGroups.useMutation({
    onError: (error) => fail(error, t('v3.groups.assign.subject'), 'save'),
  });
  const createGroup = trpc.groups.create.useMutation({
    onError: (error) => fail(error, t('v3.groups.assign.groupSubject'), 'create'),
  });

  const pending = holdingAssign.isPending || accountAssign.isPending || createGroup.isPending;
  const allGroups = allGroupsQuery.data;
  // The list is only honest once BOTH have answered: the names come from one
  // query and which of them are already ticked from another, and a list drawn
  // from the first alone claims every group is unticked.
  const loading = allGroups === undefined || (entityIds.length > 0 && commonGroups === undefined);

  const applyDiff = async (addedGroupIds: string[], removedGroupIds: string[]) => {
    if (isHoldings) {
      await holdingAssign.mutateAsync({ holdingIds: entityIds, addedGroupIds, removedGroupIds });
    } else {
      await accountAssign.mutateAsync({ accountIds: entityIds, addedGroupIds, removedGroupIds });
    }
  };

  const handleSave = async () => {
    const diff = groupAssignmentDiff(
      new Set((commonGroups ?? []).map((group) => group.id)),
      selectedIds
    );
    if (isEmptyDiff(diff)) {
      onOpenChange(false);
      return;
    }
    setFailure(null);
    try {
      await applyDiff(diff.addedGroupIds, diff.removedGroupIds);
      showSuccess(describeAssignment(diff, t));
      onOpenChange(false);
      // In the background: the sheet is already gone, and holding it open while
      // every portfolio query refetches would be a spinner over a finished job.
      void invalidatePortfolioQueries(utils);
    } catch {
      // `onError` has already written the line under the button.
    }
  };

  /** Empty state: there are no groups at all, so creating one and applying it
   *  is a single intent and gets a single button. */
  const handleCreateAndAssign = async () => {
    const name = newName.trim();
    if (name.length === 0) return;
    setFailure(null);
    try {
      const created = await createGroup.mutateAsync({ name, color: newColor, description: null });
      await utils.groups.getAll.invalidate();
      await applyDiff([created.id], []);
      showSuccess(t('v3.groups.assign.toast.createdAndAssigned', { name: created.name }));
      onOpenChange(false);
      void invalidatePortfolioQueries(utils);
    } catch {
      // `onError` has already written the line under the button.
    }
  };

  /** Standard state: create one and tick it, but stay — the reader opened this
   *  to choose groups and may have more to choose. */
  const handleCreateAndTick = async () => {
    const name = newName.trim();
    if (name.length === 0) return;
    setFailure(null);
    try {
      const created = await createGroup.mutateAsync({ name, color: newColor, description: null });
      await utils.groups.getAll.invalidate();
      setSelectedIds((previous) => new Set(previous).add(created.id));
      setNewName('');
      setNewColor(GROUP_COLORS[0]);
      setCreating(false);
      showSuccess(t('v3.groups.page.created', { name: created.name }));
    } catch {
      // `onError` has already written the line under the button.
    }
  };

  const toggle = (groupId: string) => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const count = entityIds.length;
  const countLabel = isHoldings
    ? t('v3.groups.assign.holdingCount', { count })
    : t('v3.groups.assign.accountCount', { count });
  // Keyed on the group list alone, never on `loading`: with no groups there is
  // nothing `getCommonGroups` could pre-tick, and waiting for it would title the
  // sheet "Assign groups" over a skeleton and then rename it mid-flight.
  if (allGroups !== undefined && allGroups.length === 0) {
    return (
      <FormSheet
        open={open}
        onOpenChange={(next) => {
          if (pending) return;
          onOpenChange(next);
        }}
        title={t('v3.groups.assign.firstTitle')}
        description={t('v3.groups.assign.firstDescription', { entities: countLabel })}
      >
        <div className="flex flex-col gap-4">
          <Field label={t('v3.groups.page.name')} htmlFor="v3-assign-first-group-name">
            <Input
              id="v3-assign-first-group-name"
              autoFocus
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder={t('v3.groups.page.namePlaceholder')}
              disabled={pending}
              maxLength={200}
            />
          </Field>
          <Field label={t('v3.groups.page.colour')}>
            <GroupColorChoice value={newColor} onChange={setNewColor} disabled={pending} />
          </Field>
          <FormActions
            submitLabel={t('v3.groups.assign.createAndAssign')}
            pendingLabel={t('v3.groups.assign.creating')}
            onSubmit={() => void handleCreateAndAssign()}
            onCancel={() => onOpenChange(false)}
            blockers={createAndAssignBlockers(newName, t)}
            pending={pending}
            error={failure}
          />
        </div>
      </FormSheet>
    );
  }

  return (
    <FormSheet
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
      title={t('v3.groups.assign.title')}
      description={t('v3.groups.assign.description', { entities: countLabel })}
    >
      <div className="flex flex-col gap-4">
        {loading ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only">{t('v3.groups.assign.loading')}</span>
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} aria-hidden="true" className="h-9 w-full rounded-md" />
            ))}
          </div>
        ) : (
          <GroupChecklist
            groups={allGroups ?? []}
            selectedIds={selectedIds}
            onToggle={toggle}
            disabled={pending}
          />
        )}

        {creating ? (
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <Field label={t('v3.groups.page.name')} htmlFor="v3-assign-new-group-name">
              <Input
                id="v3-assign-new-group-name"
                autoFocus
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder={t('v3.groups.page.namePlaceholder')}
                disabled={createGroup.isPending}
                maxLength={200}
              />
            </Field>
            <Field label={t('v3.groups.page.colour')}>
              <GroupColorChoice
                value={newColor}
                onChange={setNewColor}
                disabled={createGroup.isPending}
              />
            </Field>
            <div className="flex flex-col gap-2">
              <div className="flex flex-col-reverse gap-2 lg:flex-row lg:justify-end">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={createGroup.isPending}
                  onClick={() => {
                    setCreating(false);
                    setNewName('');
                  }}
                >
                  {t('v3.groups.page.cancel')}
                </Button>
                <Button
                  size="sm"
                  disabled={createGroup.isPending || newName.trim().length === 0}
                  onClick={() => void handleCreateAndTick()}
                >
                  {createGroup.isPending
                    ? t('v3.groups.assign.creating')
                    : t('v3.groups.page.createGroup')}
                </Button>
              </div>
              {newName.trim().length === 0 ? (
                <p className="text-caption text-muted-foreground lg:text-right">
                  {t('v3.groups.page.needName')}
                </p>
              ) : null}
              {/* The sheet's own failure line is not rendered while this is
                  open, so a failed create has to say so here. */}
              {failure ? (
                <p role="alert" className="text-caption text-destructive lg:text-right">
                  {failure}
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={pending || loading}
            onClick={() => setCreating(true)}
            className={cn(
              'flex w-full items-center gap-2 border-t border-border px-2 pt-4 pb-2 text-left text-body text-muted-foreground transition-colors duration-fast',
              'hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              'disabled:pointer-events-none disabled:opacity-50'
            )}
          >
            <Plus className="size-4" aria-hidden="true" />
            {t('v3.groups.assign.newGroup')}
          </button>
        )}

        {/* One action row at a time. Both on screen at once put two "Cancel"
            buttons 80px apart, cancelling different things — the sub-form and
            the whole sheet — and nothing on either says which. */}
        {creating ? null : (
          <FormActions
            submitLabel={t('v3.groups.assign.save')}
            pendingLabel={t('v3.groups.assign.saving')}
            onSubmit={() => void handleSave()}
            onCancel={() => onOpenChange(false)}
            blockers={loading ? [t('v3.groups.assign.stillLoading')] : []}
            pending={pending}
            error={failure}
          />
        )}
      </div>
    </FormSheet>
  );
}
