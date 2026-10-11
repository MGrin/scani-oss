import { Input } from '@scani/ui/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { showSuccess } from '@scani/ui/ui/use-toast';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import type { WrapperRegion, WrapperRow } from '../../lib/wrappers';
import { Field } from '../form/Field';
import { FormActions, FormSheet } from '../form/FormSheet';
import { useWrapperChoices, WrapperSelect } from './WrapperField';

export interface AccountDraft {
  name: string;
  typeId: string;
  wrapper: string | null;
}

interface AccountTypeOption {
  id: string;
  name: string;
  class: string;
}

/** The types on the account's own side: a type change never crosses asset and liability (SC-1645 Q4). */
export function typesOfClass<T extends AccountTypeOption>(
  types: readonly T[],
  currentTypeId: string
): T[] {
  const side = types.find((type) => type.id === currentTypeId)?.class;
  return types.filter((type) => type.class === side);
}

/** Only the fields that changed, or null when nothing did. */
export function accountUpdatePayload(
  original: AccountDraft,
  draft: AccountDraft
): Partial<AccountDraft> | null {
  const payload: Partial<AccountDraft> = {};
  const name = draft.name.trim();
  if (name !== original.name) payload.name = name;
  if (draft.typeId !== original.typeId) payload.typeId = draft.typeId;
  if (draft.wrapper !== original.wrapper) payload.wrapper = draft.wrapper;
  return Object.keys(payload).length > 0 ? payload : null;
}

export function EditAccountFields({
  draft,
  onChange,
  types,
  wrappers,
  region,
  disabled,
}: {
  draft: AccountDraft;
  onChange: (patch: Partial<AccountDraft>) => void;
  types: readonly AccountTypeOption[];
  wrappers: readonly WrapperRow[];
  region: WrapperRegion | null;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const isAsset = types.find((type) => type.id === draft.typeId)?.class !== 'liability';
  return (
    <>
      <Field label={t('v3.capture.account.name')} htmlFor="edit-account-name">
        <Input
          id="edit-account-name"
          value={draft.name}
          onChange={(event) => onChange({ name: event.target.value })}
          disabled={disabled}
        />
      </Field>
      <Field label={t('v3.capture.account.type')}>
        <Select
          value={draft.typeId}
          onValueChange={(typeId) => onChange({ typeId })}
          disabled={disabled}
        >
          <SelectTrigger aria-label={t('v3.capture.account.typeLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {typesOfClass(types, draft.typeId).map((type) => (
              <SelectItem key={type.id} value={type.id}>
                {type.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {isAsset ? (
        <WrapperSelect
          id="edit-account-wrapper"
          value={draft.wrapper}
          onChange={(wrapper) => onChange({ wrapper })}
          wrappers={wrappers}
          region={region}
          disabled={disabled}
        />
      ) : null}
    </>
  );
}

/** SC-1645: an account's name, type and wrapper. Nothing in v3 edited an account before. */
export function EditAccountSheet({
  account,
  open,
  onOpenChange,
}: {
  account: { id: string; name: string; typeId: string; wrapper: string | null };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const types = trpc.accountTypes.getAll.useQuery();
  const { wrappers, region } = useWrapperChoices();
  const original: AccountDraft = {
    name: account.name,
    typeId: account.typeId,
    wrapper: account.wrapper,
  };
  const [draft, setDraft] = useState<AccountDraft>(original);
  const [failure, setFailure] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reseed from the record each time the sheet opens, not on every refetch while it is open
  useEffect(() => {
    if (!open) return;
    setDraft(original);
    setFailure(null);
  }, [open]);

  const update = trpc.accounts.update.useMutation({
    onSuccess: () => {
      onOpenChange(false);
      showSuccess(t('v3.entities.account.saved'));
    },
    onError: (error) => {
      const copy = describeQueryError(error, t('v3.entities.account.editTitle'), 'save');
      setFailure(`${copy.title}. ${copy.detail}`);
    },
    onSettled: () => void invalidatePortfolioQueries(utils),
  });

  const blockers = draft.name.trim() ? [] : [t('v3.capture.blocker.nameAccount')];
  const submit = () => {
    if (blockers.length > 0 || update.isPending) return;
    const data = accountUpdatePayload(original, draft);
    if (!data) {
      onOpenChange(false);
      return;
    }
    update.mutate({ id: account.id, data });
  };

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('v3.entities.account.editTitle')}
      description={t('v3.entities.account.editDescription')}
      footer={
        <FormActions
          submitLabel={t('v3.entities.account.save')}
          pendingLabel={t('v3.entities.account.saving')}
          onSubmit={submit}
          onCancel={() => onOpenChange(false)}
          blockers={blockers}
          pending={update.isPending}
          error={failure}
        />
      }
    >
      <EditAccountFields
        draft={draft}
        onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
        types={types.data ?? []}
        wrappers={wrappers}
        region={region}
        disabled={update.isPending}
      />
    </FormSheet>
  );
}
