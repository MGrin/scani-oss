import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { groupDetailPath } from '../../lib/routes';
import { AssignGroupsSheet } from '../groups/AssignGroupsSheet';

/**
 * A payee's groups, in its peek (SC-1408): the groups whose payee rule covers
 * every bill this payee sends, now and later. Read-only and drawn as the
 * holding peek draws a holding's groups — each badge goes to that group's page.
 * Changing them is the header action below, never a control in the peek body
 * (UI standard, rules 3 and 4).
 */
export function PayeeGroupBadges({ vendorId }: { vendorId: string }) {
  const { t } = useTranslation();
  const assignments = trpc.payments.groupAssignments.useQuery();
  const groups = trpc.groups.getAll.useQuery();
  const byId = new Map((groups.data ?? []).map((group) => [group.id, group]));
  const inGroups = (assignments.data?.payees[vendorId] ?? []).flatMap((id) => byId.get(id) ?? []);
  if (!assignments.data || !groups.data) return <span className="text-muted-foreground">—</span>;
  if (inGroups.length === 0) {
    return <span className="text-muted-foreground">{t('v3.holdings.peek.noGroups')}</span>;
  }
  return (
    <span className="flex flex-wrap justify-end gap-1.5">
      {inGroups.map((group) => (
        <Link key={group.id} to={groupDetailPath(group.id)}>
          <Badge
            variant="outline"
            className="transition-colors duration-fast hover:bg-surface-hover"
            style={group.color ? { borderColor: group.color, color: group.color } : undefined}
          >
            {group.name}
          </Badge>
        </Link>
      ))}
    </span>
  );
}

/** The peek header's "Assign groups": the same sheet Holdings and Accounts use. */
export function AssignPayeeGroupsAction({ vendorId }: { vendorId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {t('v3.groups.assign.title')}
      </Button>
      {/* Mounted only while open, for the reason `AssignGroupsSheet` gives:
          a sheet left mounted keeps the last selection ticked. */}
      {open ? (
        <AssignGroupsSheet open onOpenChange={setOpen} entityType="payees" entityIds={[vendorId]} />
      ) : null}
    </>
  );
}
