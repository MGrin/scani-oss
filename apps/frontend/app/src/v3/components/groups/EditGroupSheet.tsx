import { Input } from '@scani/ui/ui/input';
import { Textarea } from '@scani/ui/ui/textarea';
import { showSuccess } from '@scani/ui/ui/use-toast';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import { optimisticPatchGroup } from '@/v3/hooks/optimisticUpdates';
import { Field } from '../form/Field';
import { FormActions, FormSheet } from '../form/FormSheet';
import { GroupColorChoice } from './GroupColorChoice';

interface EditableGroup {
  id: string;
  name: string;
  description: string | null;
  color: string;
}

/**
 * A group's name, description and colour. Details commit on Save because a
 * text field has no other honest commit point — a name saved per keystroke
 * writes groups called "R", "Re", "Ret". Membership is edited on the page.
 */
export function EditGroupSheet({
  group,
  open,
  onOpenChange,
}: {
  group: EditableGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? '');
  const [color, setColor] = useState(group.color);
  const [failure, setFailure] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reseed from the record each time the sheet opens, not on every refetch while it is open
  useEffect(() => {
    if (!open) return;
    setName(group.name);
    setDescription(group.description ?? '');
    setColor(group.color);
    setFailure(null);
  }, [open]);

  const updateGroup = trpc.groups.update.useMutation({
    onMutate: ({ id, data }) =>
      optimisticPatchGroup(utils, id, {
        name: data.name,
        color: data.color,
        description: data.description,
      }),
    onSuccess: () => {
      onOpenChange(false);
      showSuccess(t('v3.groups.detail.toast.updated'));
    },
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      const copy = describeQueryError(error, t('v3.groups.page.subject'), 'save');
      setFailure(`${copy.title}. ${copy.detail}`);
    },
    onSettled: () => void invalidatePortfolioQueries(utils),
  });

  const blockers = name.trim() ? [] : [t('v3.groups.assign.needName')];
  const dirty =
    name !== group.name || description !== (group.description ?? '') || color !== group.color;
  const submit = () => {
    if (blockers.length > 0 || updateGroup.isPending) return;
    if (!dirty) {
      onOpenChange(false);
      return;
    }
    updateGroup.mutate({
      id: group.id,
      data: { name: name.trim(), color, description: description.trim() || null },
    });
  };

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('v3.groups.detail.editTitle')}
      description={t('v3.groups.detail.editDescription')}
      footer={
        <FormActions
          submitLabel={t('v3.groups.detail.saveChanges')}
          pendingLabel={t('v3.groups.detail.toast.updating')}
          onSubmit={submit}
          onCancel={() => onOpenChange(false)}
          blockers={blockers}
          pending={updateGroup.isPending}
          error={failure}
        />
      }
    >
      <Field label={t('v3.groups.detail.name')} htmlFor="group-name">
        <Input
          id="group-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={updateGroup.isPending}
        />
      </Field>
      <Field label={t('v3.groups.detail.description')} htmlFor="group-description">
        <Textarea
          id="group-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          maxLength={200}
          rows={2}
          disabled={updateGroup.isPending}
        />
      </Field>
      <Field label={t('v3.groups.detail.colour')}>
        <GroupColorChoice value={color} onChange={setColor} disabled={updateGroup.isPending} />
      </Field>
    </FormSheet>
  );
}
