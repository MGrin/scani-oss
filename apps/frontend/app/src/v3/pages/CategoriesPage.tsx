import { SUGGESTED_CATEGORY_KEYS } from '@scani/shared';
import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Button } from '@scani/ui/ui/button';
import { showError } from '@scani/ui/ui/use-toast';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import {
  CategoryDeleteSheet,
  type CountedCategory,
} from '../components/categories/CategoryDeleteSheet';
import {
  CATEGORY_DEFAULT_COLOR,
  type CategoryDraft,
  CategoryFormSheet,
} from '../components/categories/CategoryFormSheet';
import { CategoryRow, categoryTotal } from '../components/categories/CategoryRow';

/** A person's categories: create, rename, recolour, move and delete (SC-1652). */
export function CategoriesPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('v3.categories.page.title'));
  const utils = trpc.useUtils();
  const list = trpc.categories.list.useQuery();
  const nodes = (list.data ?? []) as CountedCategory[];
  const refresh = () =>
    Promise.all([utils.categories.list.invalidate(), utils.transactions.list.invalidate()]);

  const [draft, setDraft] = useState<CategoryDraft | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const create = trpc.categories.create.useMutation({
    onSuccess: async () => {
      await refresh();
      setDraft(null);
    },
    onError: (error) => showError(error),
  });
  const update = trpc.categories.update.useMutation({
    onSuccess: async () => {
      await refresh();
      setDraft(null);
    },
    onError: (error) => showError(error),
  });
  const remove = trpc.categories.delete.useMutation({
    onSuccess: async () => {
      await refresh();
      setDeleting(null);
    },
    onError: (error) => showError(error),
  });
  const suggest = trpc.categories.suggest.useMutation({
    onSuccess: refresh,
    onError: (error) => showError(error),
  });

  const startCreate = () =>
    setDraft({
      id: null,
      name: '',
      parentId: null,
      color: CATEGORY_DEFAULT_COLOR,
      hasChildren: false,
    });
  const startEdit = (node: CountedCategory, parentId: string | null) =>
    setDraft({
      id: node.id,
      name: node.name,
      parentId,
      color: node.color ?? CATEGORY_DEFAULT_COLOR,
      hasChildren: node.children.length > 0,
    });
  const save = () => {
    if (!draft) return;
    const fields = { name: draft.name.trim(), parentId: draft.parentId, color: draft.color };
    if (draft.id) update.mutate({ id: draft.id, ...fields });
    else create.mutate(fields);
  };

  const parentChoices = nodes.filter((node) => node.id !== draft?.id);
  const openNode = nodes
    .flatMap((node) => [node, ...node.children])
    .find((node) => node.id === draft?.id);
  const openTotal = openNode ? categoryTotal(openNode) : 0;

  return (
    <PageLayout measure="narrow">
      <PageHeader
        title={t('v3.categories.page.title')}
        action={
          <Button onClick={startCreate}>
            <Plus className="me-1.5 size-4" aria-hidden="true" />
            {t('v3.categories.page.new')}
          </Button>
        }
      />

      {list.isLoading ? null : nodes.length === 0 ? (
        <div className="flex flex-col items-start gap-3 py-6">
          <p className="text-body text-muted-foreground">{t('v3.categories.empty.title')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={suggest.isPending}
              onClick={() =>
                suggest.mutate({
                  names: Object.fromEntries(
                    SUGGESTED_CATEGORY_KEYS.map((key) => [key, t(`v3.categories.suggested.${key}`)])
                  ),
                })
              }
            >
              <Sparkles className="me-1.5 size-4" aria-hidden="true" />
              {t('v3.categories.empty.suggest')}
            </Button>
            <Button type="button" variant="outline" onClick={startCreate}>
              <Plus className="me-1.5 size-4" aria-hidden="true" />
              {t('v3.categories.empty.create')}
            </Button>
          </div>
        </div>
      ) : (
        <ul className="flex flex-col">
          {nodes.flatMap((parent) => [
            <CategoryRow
              key={parent.id}
              node={parent}
              depth={0}
              onOpen={() => startEdit(parent, null)}
            />,
            ...parent.children.map((child) => (
              <CategoryRow
                key={child.id}
                node={child}
                depth={1}
                onOpen={() => startEdit(child, parent.id)}
              />
            )),
          ])}
        </ul>
      )}

      <CategoryFormSheet
        draft={draft}
        parents={parentChoices}
        onChange={setDraft}
        onClose={() => setDraft(null)}
        onSave={save}
        onDelete={() => {
          if (!draft?.id) return;
          setDeleting(draft.id);
          setDraft(null);
        }}
        total={openTotal}
        pending={create.isPending || update.isPending}
      />

      <CategoryDeleteSheet
        key={deleting ?? 'none'}
        nodes={nodes}
        categoryId={deleting}
        onClose={() => setDeleting(null)}
        pending={remove.isPending}
        onConfirm={(replacementId) => {
          if (deleting) remove.mutate({ id: deleting, replacementId });
        }}
      />
    </PageLayout>
  );
}
