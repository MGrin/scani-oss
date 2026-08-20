import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import type { NewAccountDraft, PickMode } from '../../lib/manual-entry';
import { Field } from '../form/Field';
import { RecordPicker } from '../form/RecordPicker';

/**
 * Which account inside the institution — existing, or being created.
 *
 * The list is filtered by the institution above it, with two edges that are
 * v2's and correct:
 *
 * - **A new institution has no accounts**, so the list is empty rather than
 *   showing every account the user owns under a heading that no longer applies.
 * - **No institution chosen shows everything**, and picking an account then
 *   fills the institution in above. Someone who knows the account name but not
 *   which of two brokers it sits under should not have to answer the harder
 *   question first.
 */

interface AccountFieldProps {
  mode: PickMode;
  value: string;
  draft: NewAccountDraft;
  /** Empty while nothing is chosen; ignored entirely when `institutionIsNew`. */
  institutionId: string;
  institutionIsNew: boolean;
  onModeChange: (mode: PickMode) => void;
  /** `institutionId` is the account's own, so the picker can fill the field
   *  above when it was left empty. */
  onSelect: (accountId: string, institutionId: string | null) => void;
  onDraftChange: (patch: Partial<NewAccountDraft>) => void;
  disabled?: boolean;
}

export function AccountField({
  mode,
  value,
  draft,
  institutionId,
  institutionIsNew,
  onModeChange,
  onSelect,
  onDraftChange,
  disabled,
}: AccountFieldProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const accounts = trpc.accounts.getAll.useQuery();
  const types = trpc.accountTypes.getAll.useQuery();

  const all = accounts.data ?? [];
  const scoped = institutionIsNew
    ? []
    : institutionId
      ? all.filter((account) => account.institutionId === institutionId)
      : all;
  const term = query.trim().toLowerCase();
  const options = (term ? scoped.filter((a) => a.name.toLowerCase().includes(term)) : scoped)
    .slice(0, 20)
    .map((account) => ({ id: account.id, label: account.name }));

  const selectedLabel = all.find((account) => account.id === value)?.name ?? value;

  if (mode === 'existing') {
    return (
      <Field
        label={t('v3.capture.account.label')}
        htmlFor="manual-account"
        hint={institutionIsNew ? t('v3.capture.account.newInstitutionHint') : undefined}
      >
        <RecordPicker
          inputId="manual-account"
          ariaLabel="account"
          value={value ? { id: value, label: selectedLabel } : null}
          onSelect={(id) => {
            onSelect(id, all.find((account) => account.id === id)?.institutionId ?? null);
            setQuery('');
          }}
          onClear={() => {
            onSelect('', null);
            setQuery('');
            setOpen(true);
          }}
          query={query}
          onQueryChange={setQuery}
          open={open}
          onOpenChange={setOpen}
          options={options}
          isLoading={accounts.isLoading}
          placeholder={t('v3.capture.account.searchPlaceholder')}
          emptyLabel={t('v3.capture.account.noResults')}
          createLabel={(text) =>
            text ? t('v3.capture.account.addNamed', { name: text }) : t('v3.capture.account.addNew')
          }
          onCreate={(text) => {
            onDraftChange({ name: text });
            onModeChange('new');
            setQuery('');
            setOpen(false);
          }}
          disabled={disabled}
        />
      </Field>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="ghost"
        className="-ml-2 self-start"
        disabled={disabled}
        onClick={() => {
          onDraftChange({ name: '', typeId: '' });
          onModeChange('existing');
        }}
      >
        <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
        {t('v3.capture.account.pickExisting')}
      </Button>

      <Field label={t('v3.capture.account.name')} htmlFor="manual-account-name">
        <Input
          id="manual-account-name"
          value={draft.name}
          onChange={(event) => onDraftChange({ name: event.target.value })}
          placeholder={t('v3.capture.account.namePlaceholder')}
          className="text-body"
          disabled={disabled}
        />
      </Field>

      <Field label={t('v3.capture.account.type')}>
        <Select
          value={draft.typeId}
          onValueChange={(typeId) => onDraftChange({ typeId })}
          disabled={disabled}
        >
          <SelectTrigger className="text-body" aria-label={t('v3.capture.account.typeLabel')}>
            <SelectValue placeholder={t('v3.capture.account.typePlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {(types.data ?? []).map((type) => (
              <SelectItem key={type.id} value={type.id} className="text-body">
                {type.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  );
}
