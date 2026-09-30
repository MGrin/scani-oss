import { Input } from '@scani/ui/ui/input';
import { showSuccess } from '@scani/ui/ui/use-toast';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { insertCreatedGroup } from '@/v3/hooks/optimisticUpdates';
import { groupDetailPath } from '../../lib/routes';
import { Field } from '../form/Field';
import { FormActions, FormSheet } from '../form/FormSheet';
import { GROUP_COLORS, GroupColorChoice } from './GroupColorChoice';

/**
 * Creating a group: a name and a colour. Members are added on the group's own
 * page, where the reader can see what each one does to its value, so creating
 * navigates there. The colour is seeded at random per open, so ten groups made
 * in a row are not ten red ones.
 */
export function CreateGroupSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(GROUP_COLORS[0]);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setColor(GROUP_COLORS[Math.floor(Math.random() * GROUP_COLORS.length)] ?? GROUP_COLORS[0]);
    setFailure(null);
  }, [open]);

  const createGroup = trpc.groups.create.useMutation({
    onSuccess: (group) => {
      insertCreatedGroup(utils, group);
      onOpenChange(false);
      showSuccess(t('v3.groups.page.created', { name: group.name }));
      navigate(groupDetailPath(group.id));
    },
    onError: (error) => {
      const copy = describeQueryError(error, t('v3.groups.page.subject'), 'create');
      setFailure(`${copy.title}. ${copy.detail}`);
    },
    onSettled: () => void utils.groups.getAllWithCounts.invalidate(),
  });

  const blockers = name.trim() ? [] : [t('v3.groups.assign.needName')];
  const submit = () => {
    if (blockers.length > 0 || createGroup.isPending) return;
    createGroup.mutate({ name: name.trim(), color, description: null });
  };

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('v3.groups.page.newGroup')}
      description={t('v3.groups.page.sheetDescription')}
      footer={
        <FormActions
          submitLabel={t('v3.groups.page.createGroup')}
          pendingLabel={t('v3.groups.page.creating')}
          onSubmit={submit}
          onCancel={() => onOpenChange(false)}
          blockers={blockers}
          pending={createGroup.isPending}
          error={failure}
        />
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t('v3.groups.page.name')} htmlFor="new-group-name">
          <Input
            id="new-group-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('v3.groups.page.namePlaceholder')}
            disabled={createGroup.isPending}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        </Field>
        <Field label={t('v3.groups.page.colour')}>
          <GroupColorChoice value={color} onChange={setColor} disabled={createGroup.isPending} />
        </Field>
      </div>
    </FormSheet>
  );
}
