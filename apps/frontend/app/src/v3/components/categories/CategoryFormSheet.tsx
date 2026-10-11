import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { V3_ROUTES } from '../../lib/routes';
import { FormActions, FormSheet } from '../form/FormSheet';
import { GROUP_COLORS, GroupColorChoice } from '../groups/GroupColorChoice';

const TOP_LEVEL = '__top';
export const CATEGORY_DEFAULT_COLOR: string = GROUP_COLORS[9];

export interface CategoryDraft {
  id: string | null;
  name: string;
  parentId: string | null;
  color: string;
  hasChildren: boolean;
}

/** Creates or edits one category: its name, where it sits, and its colour (SC-1652). */
export function CategoryFormSheet({
  draft,
  parents,
  onChange,
  onClose,
  onSave,
  onDelete,
  total,
  pending,
}: {
  draft: CategoryDraft | null;
  parents: readonly { id: string; name: string }[];
  onChange: (draft: CategoryDraft) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete: () => void;
  /** The open category's transactions, its subcategories' included. */
  total: number;
  pending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <FormSheet
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={draft?.id ? t('v3.categories.page.editTitle') : t('v3.categories.page.newTitle')}
      description={t('v3.categories.page.formDescription')}
      footer={
        <FormActions
          submitLabel={t('v3.categories.page.save')}
          pendingLabel={t('v3.categories.page.saving')}
          onSubmit={onSave}
          onCancel={onClose}
          blockers={draft && !draft.name.trim() ? [t('v3.categories.page.nameRequired')] : []}
          pending={pending}
          error={null}
        />
      }
    >
      {draft ? (
        <CategoryFormBody
          draft={draft}
          parents={parents}
          total={total}
          onChange={onChange}
          onDelete={onDelete}
        />
      ) : null}
    </FormSheet>
  );
}

/** The sheet's fields, plus Delete once the category exists: a phone row has no room for it (SC-1652). */
export function CategoryFormBody({
  draft,
  parents,
  total,
  onChange,
  onDelete,
}: {
  draft: CategoryDraft;
  parents: readonly { id: string; name: string }[];
  total: number;
  onChange: (draft: CategoryDraft) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <Input
        value={draft.name}
        maxLength={60}
        aria-label={t('v3.categories.empty.namePlaceholder')}
        placeholder={t('v3.categories.empty.namePlaceholder')}
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
      />
      <Select
        value={draft.parentId ?? TOP_LEVEL}
        disabled={draft.hasChildren}
        onValueChange={(value) =>
          onChange({ ...draft, parentId: value === TOP_LEVEL ? null : value })
        }
      >
        <SelectTrigger aria-label={t('v3.categories.page.parent')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={TOP_LEVEL}>{t('v3.categories.page.topLevel')}</SelectItem>
          {parents.map((node) => (
            <SelectItem key={node.id} value={node.id}>
              {node.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {draft.hasChildren ? (
        <p className="text-label text-muted-foreground">{t('v3.categories.page.hasChildren')}</p>
      ) : null}
      <GroupColorChoice value={draft.color} onChange={(color) => onChange({ ...draft, color })} />
      {draft.id ? (
        <div className="flex flex-col items-start gap-2 border-t border-border pt-4">
          <Link
            to={`${V3_ROUTES.transactions}?category=${draft.id}`}
            className="text-label text-muted-foreground underline-offset-4 hover:underline"
          >
            {t('v3.categories.page.count', { count: total })}
          </Link>
          <Button
            type="button"
            variant="ghost"
            className="-ms-3 text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="me-2 size-4" aria-hidden="true" />
            {t('v3.categories.page.deleteAction')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
