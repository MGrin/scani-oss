import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CategoryChip } from './CategoryChip';
import type { CountedCategory } from './CategoryDeleteSheet';

/** A parent's rows include its subcategories', so the number matches the ledger it opens. */
export function categoryTotal(node: CountedCategory): number {
  return (
    node.transactionCount + node.children.reduce((sum, child) => sum + child.transactionCount, 0)
  );
}

/**
 * One category in the list: the whole row opens it (SC-1652). Inline Edit and
 * Delete buttons left the count no room on a 390px phone, where it wrapped and
 * ran under them, so editing and deleting both live in the sheet the row opens.
 */
export function CategoryRow({
  node,
  depth,
  onOpen,
}: {
  node: CountedCategory;
  depth: 0 | 1;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  return (
    <li className="border-b border-border" data-depth={depth}>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-14 w-full items-center gap-3 py-3 text-start hover:bg-muted/50"
      >
        <span
          className={
            depth
              ? 'flex min-w-0 flex-1 flex-col items-start gap-1 ps-6'
              : 'flex min-w-0 flex-1 flex-col items-start gap-1'
          }
        >
          <CategoryChip name={node.name} color={node.color} />
          <span className="whitespace-nowrap text-label text-muted-foreground">
            {t('v3.categories.page.count', { count: categoryTotal(node) })}
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    </li>
  );
}
