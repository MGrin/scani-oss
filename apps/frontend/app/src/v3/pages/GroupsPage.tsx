import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { insertCreatedGroup } from '@/v2/hooks/optimisticUpdates';
import { Field } from '../components/form/Field';
import { GROUP_COLORS, GroupColorChoice } from '../components/groups/GroupColorChoice';
import { GroupsList } from '../components/groups/GroupsList';
import { groupDetailPath } from '../lib/routes';

/**
 * The user's own labels across holdings and accounts.
 *
 * Creating one is an **inline block at the top of the list**, not a modal. QA
 * 10.1 named the inconsistency — every v3 detail surface is a docked peek or a
 * page, and only the create flows were centred wizards — and a group needs one
 * required field, so a wizard was never earning its three steps. Creating then
 * navigates straight to the new group's page, which is where members are added:
 * v2 asked for membership as steps two and three of the create flow, before the
 * group existed and before the reader had any way to see what they had done.
 *
 * The colour is seeded at random per open rather than fixed, so ten groups made
 * in a row are not ten red ones.
 */
export function GroupsPage() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const groupsQuery = trpc.groups.getAllWithCounts.useQuery();
  const valuesQuery = trpc.groups.getValues.useQuery();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(GROUP_COLORS[0]);

  const openCreate = () => {
    setName('');
    setColor(GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)] ?? GROUP_COLORS[0]);
    setCreating(true);
  };

  const createGroup = trpc.groups.create.useMutation({
    onSuccess: (group) => {
      insertCreatedGroup(utils, group);
      setCreating(false);
      showSuccess(`Group “${group.name}” created`);
      navigate(groupDetailPath(group.id));
    },
    onError: (error) => showError(error, 'Creating the group'),
    onSettled: () => void utils.groups.getAllWithCounts.invalidate(),
  });

  const canCreate = name.trim().length > 0 && !createGroup.isPending;

  return (
    <PageLayout measure="wide">
      <PageHeader
        title="Groups"
        action={
          <Button onClick={openCreate} disabled={creating}>
            <Plus className="mr-1.5 size-4" aria-hidden="true" />
            New group
          </Button>
        }
      />

      {creating ? (
        <Block className="flex flex-col gap-3 p-4">
          <Field label="Name" htmlFor="new-group-name">
            <Input
              id="new-group-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Retirement, taxable, the joint one…"
              disabled={createGroup.isPending}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canCreate) {
                  event.preventDefault();
                  createGroup.mutate({ name: name.trim(), color, description: null });
                }
              }}
            />
          </Field>
          <Field label="Colour">
            <GroupColorChoice value={color} onChange={setColor} disabled={createGroup.isPending} />
          </Field>
          <div className="flex items-center gap-2">
            {/* Cancel leads, as it does in `ConfirmAction` and for the same
             *  reason: the trigger that opened this block sat up and to the
             *  right, and the commit must not land under that finger. */}
            <Button
              variant="ghost"
              size="sm"
              disabled={createGroup.isPending}
              onClick={() => setCreating(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!canCreate}
              onClick={() => createGroup.mutate({ name: name.trim(), color, description: null })}
            >
              Create group
            </Button>
            {name.trim().length === 0 ? (
              <p className="text-caption text-muted-foreground">To continue: name the group.</p>
            ) : null}
          </div>
        </Block>
      ) : null}

      <GroupsList
        groups={groupsQuery.data ?? []}
        values={valuesQuery.data?.groups ?? []}
        baseCurrency={valuesQuery.data?.baseCurrency ?? 'USD'}
        // Not merged with the values query: the list is renderable the moment
        // the names arrive, and holding the whole surface back on a
        // whole-portfolio valuation to fill one column is the wrong trade.
        query={mergeQueries(groupsQuery)}
        onCreate={openCreate}
      />
    </PageLayout>
  );
}
