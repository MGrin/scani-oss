import { ChoiceRow } from '@scani/ui/v3/components/ChoiceRow';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormActions, FormSheet } from '../form/FormSheet';
import type { CategoryNodeView } from './CategoryPicker';

export interface CountedCategory extends CategoryNodeView {
  transactionCount: number;
  children: CountedCategory[];
}

function find(nodes: readonly CountedCategory[], id: string): CountedCategory | null {
  for (const parent of nodes) {
    if (parent.id === id) return parent;
    const child = parent.children.find((node) => node.id === id);
    if (child) return child;
  }
  return null;
}

/**
 * Where a deleted category's rows can go: any other category. Its own children
 * are offered under their bare names, because deleting the parent lifts them
 * to the top level (SC-1652).
 */
export function replacementOptions(
  nodes: readonly CountedCategory[],
  deletingId: string
): { id: string; label: string }[] {
  return nodes.flatMap((parent) => {
    const children = parent.children
      .filter((child) => child.id !== deletingId)
      .map((child) => ({
        id: child.id,
        label: parent.id === deletingId ? child.name : `${parent.name} › ${child.name}`,
      }));
    return parent.id === deletingId
      ? children
      : [{ id: parent.id, label: parent.name }, ...children];
  });
}

export function CategoryDeleteBody({
  nodes,
  categoryId,
  replacementId,
  onReplacement,
}: {
  nodes: readonly CountedCategory[];
  categoryId: string;
  replacementId: string | null;
  onReplacement: (id: string | null) => void;
}) {
  const { t } = useTranslation();
  const category = find(nodes, categoryId);
  if (!category) return null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-body">
        {t('v3.categories.delete.where', {
          count: category.transactionCount,
          name: category.name,
        })}
      </p>
      {category.children.length > 0 ? (
        <p className="text-body text-muted-foreground">{t('v3.categories.delete.lifted')}</p>
      ) : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">{t('v3.categories.delete.legend')}</legend>
        <ChoiceRow
          name="category-delete-destination"
          checked={replacementId === null}
          onSelect={() => onReplacement(null)}
        >
          <span className="text-body">{t('v3.categories.uncategorized')}</span>
        </ChoiceRow>
        {replacementOptions(nodes, categoryId).map((option) => (
          <ChoiceRow
            key={option.id}
            name="category-delete-destination"
            checked={replacementId === option.id}
            onSelect={() => onReplacement(option.id)}
          >
            <span className="text-body">{option.label}</span>
          </ChoiceRow>
        ))}
      </fieldset>
    </div>
  );
}

export function CategoryDeleteSheet({
  nodes,
  categoryId,
  onClose,
  onConfirm,
  pending,
}: {
  nodes: readonly CountedCategory[];
  categoryId: string | null;
  onClose: () => void;
  onConfirm: (replacementId: string | undefined) => void;
  pending: boolean;
}) {
  const { t } = useTranslation();
  const [replacementId, setReplacementId] = useState<string | null>(null);
  const category = categoryId ? find(nodes, categoryId) : null;
  return (
    <FormSheet
      open={category !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('v3.categories.delete.title', { name: category?.name ?? '' })}
      description={t('v3.categories.delete.description')}
      footer={
        <FormActions
          submitLabel={t('v3.categories.delete.submit')}
          pendingLabel={t('v3.categories.delete.pending')}
          onSubmit={() => onConfirm(replacementId ?? undefined)}
          onCancel={onClose}
          blockers={[]}
          pending={pending}
          error={null}
        />
      }
    >
      {categoryId ? (
        <CategoryDeleteBody
          nodes={nodes}
          categoryId={categoryId}
          replacementId={replacementId}
          onReplacement={setReplacementId}
        />
      ) : null}
    </FormSheet>
  );
}
