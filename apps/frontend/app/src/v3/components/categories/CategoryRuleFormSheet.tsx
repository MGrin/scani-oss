import type { CategoryRuleSave } from '@scani/shared';
import { Input } from '@scani/ui/ui/input';
import { Label } from '@scani/ui/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { useTranslation } from 'react-i18next';
import { FormActions, FormSheet } from '../form/FormSheet';
import { CategoryPickerQuery } from './CategoryPickerQuery';

export function CategoryRuleFormSheet({
  draft,
  accounts,
  onChange,
  onClose,
  onSave,
  pending,
  error,
}: {
  draft: CategoryRuleSave | null;
  accounts: readonly { id: string; name: string }[];
  onChange: (draft: CategoryRuleSave) => void;
  onClose: () => void;
  onSave: () => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const lengths = draft ? [...draft.payeeText.trim()].length : 0;
  const valid = draft && lengths >= 3 && lengths <= 200 && draft.accountId && draft.categoryId;
  return (
    <FormSheet
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
      title={t(draft?.id ? 'v3.categories.rules.edit' : 'v3.categories.rules.add')}
      description={t('v3.categories.rules.definition')}
      footer={
        <FormActions
          submitLabel={t('v3.categories.page.save')}
          pendingLabel={t('v3.categories.page.saving')}
          onSubmit={onSave}
          onCancel={onClose}
          blockers={valid ? [] : [t('v3.categories.rules.required')]}
          pending={pending}
          error={error}
        />
      }
    >
      {draft && (
        <div className="flex flex-col gap-4">
          <div className="space-y-2">
            <Label htmlFor="rule-payee">{t('v3.categories.rules.payee')}</Label>
            <Input
              id="rule-payee"
              value={draft.payeeText}
              onChange={(e) => onChange({ ...draft, payeeText: e.target.value })}
            />
          </div>
          <p className="text-label text-muted-foreground">
            {t('v3.categories.rules.normalization')}
          </p>
          <div className="space-y-2">
            <Label htmlFor="rule-account">{t('v3.categories.rules.account')}</Label>
            <Select
              value={draft.accountId || undefined}
              onValueChange={(accountId) => onChange({ ...draft, accountId })}
            >
              <SelectTrigger
                id="rule-account"
                className="h-11"
                aria-label={t('v3.categories.rules.account')}
              >
                <SelectValue placeholder={t('v3.categories.rules.chooseAccount')} />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((account) => (
                  <SelectItem key={account.id} value={account.id}>
                    {account.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <fieldset>
            <legend className="mb-2 text-label">{t('v3.categories.rules.category')}</legend>
            <CategoryPickerQuery
              name="rule-category"
              value={draft.categoryId || null}
              onChange={(id) => onChange({ ...draft, categoryId: id ?? '' })}
            />
          </fieldset>
        </div>
      )}
    </FormSheet>
  );
}
