import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Checkbox } from '@scani/ui/ui/checkbox';
import { Input } from '@scani/ui/ui/input';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { GROUP_COLORS } from '../groups/GroupColorChoice';

/**
 * Which groups a bill is in, with a new group made on the spot (SC-1408).
 *
 * `viaPayee` are the groups the bill's payee puts every one of its bills in.
 * They arrive ticked and are marked, because unticking one is not the same
 * act as unticking a group of the bill's own: it keeps this one bill out of a
 * group its payee stays in.
 *
 * A group created here is ticked and the picker stays open, the same bargain
 * `AssignGroupsSheet` makes: the reader came to choose groups and may have
 * more to choose.
 */
export function PaymentGroupsPicker({
  value,
  onChange,
  viaPayee = [],
  disabled = false,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  viaPayee?: readonly string[];
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const groups = trpc.groups.getAll.useQuery();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const createGroup = trpc.groups.create.useMutation();

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const created = await createGroup.mutateAsync({
      name: trimmed,
      // The next colour in the palette, so two groups made in a row are told
      // apart without the reader having to choose.
      color: GROUP_COLORS[(groups.data?.length ?? 0) % GROUP_COLORS.length] ?? GROUP_COLORS[0],
      description: null,
    });
    await utils.groups.getAll.invalidate();
    onChange([...value, created.id]);
    setName('');
    setCreating(false);
  };

  return (
    <fieldset disabled={disabled} className="flex flex-col gap-2">
      <legend className="text-label">{t('v3.money.groups.label')}</legend>
      <p className="text-caption text-muted-foreground">{t('v3.money.groups.hint')}</p>
      {groups.isError ? (
        <button type="button" onClick={() => void groups.refetch()}>
          {t('v3.feedback.stale.retry')}
        </button>
      ) : null}
      {(groups.data ?? []).map((group) => (
        <label
          htmlFor={`payment-group-${group.id}`}
          key={group.id}
          className="flex items-center gap-2 py-1"
        >
          <Checkbox
            id={`payment-group-${group.id}`}
            checked={value.includes(group.id)}
            onCheckedChange={(checked) =>
              onChange(checked ? [...value, group.id] : value.filter((id) => id !== group.id))
            }
          />
          <span
            aria-hidden="true"
            className="size-2.5 shrink-0 rounded-full"
            style={{ backgroundColor: group.color }}
          />
          {group.name}
          {viaPayee.includes(group.id) ? (
            <Badge variant="outline">{t('v3.membership.payee')}</Badge>
          ) : null}
        </label>
      ))}
      {creating ? (
        // Not a <form>: this sits inside the bill's own form, and a nested one
        // is invalid HTML whose Enter would submit the bill.
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              void create().catch(() => {});
            }}
            aria-label={t('v3.money.groups.newGroupName')}
            placeholder={t('v3.money.groups.newGroupName')}
            maxLength={50}
            className="text-body"
          />
          <Button
            type="button"
            disabled={!name.trim() || createGroup.isPending}
            onClick={() => void create().catch(() => {})}
          >
            {t('v3.money.groups.create')}
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          // Flush with the checkboxes above, as `BackLink` sits flush with
          // the title: a ghost button's padding is not an indent.
          className="-ms-3 self-start"
          onClick={() => setCreating(true)}
        >
          <Plus className="me-1.5 size-4" aria-hidden="true" />
          {t('v3.money.groups.newGroup')}
        </Button>
      )}
      {createGroup.error ? (
        <p role="alert" className="text-caption text-destructive">
          {t('v3.money.groups.createFailed')}
        </p>
      ) : null}
    </fieldset>
  );
}
