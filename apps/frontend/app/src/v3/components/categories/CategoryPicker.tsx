import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { ChoiceRow } from '@scani/ui/v3/components/ChoiceRow';
import { Plus, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { V3_ROUTES } from '../../lib/routes';
import { CategoryChip } from './CategoryChip';

export interface CategoryNodeView {
  id: string;
  name: string;
  color: string | null;
  children: CategoryNodeView[];
}

/** `Parent › Child` for a child, the name alone for a parent, null when the id is not in the tree. */
export function formatCategoryPath(nodes: readonly CategoryNodeView[], id: string): string | null {
  for (const parent of nodes) {
    if (parent.id === id) return parent.name;
    const child = parent.children.find((node) => node.id === id);
    if (child) return `${parent.name} › ${child.name}`;
  }
  return null;
}

function matches(node: CategoryNodeView, query: string): boolean {
  return node.name.toLowerCase().includes(query);
}

/** Parents that match, or that hold a child that matches; a matching parent keeps all its children. */
function visibleTree(nodes: readonly CategoryNodeView[], query: string): CategoryNodeView[] {
  if (!query) return [...nodes];
  return nodes.flatMap((parent) => {
    if (matches(parent, query)) return [parent];
    const children = parent.children.filter((child) => matches(child, query));
    return children.length > 0 ? [{ ...parent, children }] : [];
  });
}

function hasExactName(nodes: readonly CategoryNodeView[], query: string): boolean {
  return nodes.some(
    (parent) =>
      parent.name.toLowerCase() === query ||
      parent.children.some((child) => child.name.toLowerCase() === query)
  );
}

interface CategoryPickerProps {
  /** The radio group's name; two pickers can be mounted at once. */
  name: string;
  nodes: readonly CategoryNodeView[];
  value: string | null;
  onChange: (id: string | null) => void;
  /** Creates a top-level category with this name; the caller selects it once it exists. */
  onCreate: (name: string) => void;
  onSuggest: () => void;
  /** Adds a "No category" choice, for clearing a row's category. */
  allowClear?: boolean;
  busy?: boolean;
  initialQuery?: string;
}

/**
 * Picks one of a person's categories (SC-1652). Children sit indented under
 * their parent and either level can be chosen. Typing a name that does not
 * exist offers to create it. With no categories at all, the starter set is
 * offered beside creating one, and nothing is created until the person asks.
 */
export function CategoryPicker({
  name,
  nodes,
  value,
  onChange,
  onCreate,
  onSuggest,
  allowClear = false,
  busy = false,
  initialQuery = '',
}: CategoryPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(initialQuery);
  const needle = query.trim().toLowerCase();
  const visible = useMemo(() => visibleTree(nodes, needle), [nodes, needle]);
  const canCreate = needle.length > 0 && !hasExactName(nodes, needle);

  if (nodes.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-body text-muted-foreground">{t('v3.categories.empty.title')}</p>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('v3.categories.empty.namePlaceholder')}
          aria-label={t('v3.categories.empty.namePlaceholder')}
          maxLength={60}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={onSuggest} disabled={busy}>
            <Sparkles className="me-1.5 size-4" aria-hidden="true" />
            {t('v3.categories.empty.suggest')}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onCreate(query.trim())}
            disabled={busy || needle.length === 0}
          >
            <Plus className="me-1.5 size-4" aria-hidden="true" />
            {t('v3.categories.empty.create')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="sr-only">{t('v3.categories.picker.legend')}</legend>
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t('v3.categories.picker.searchPlaceholder')}
        aria-label={t('v3.categories.picker.searchPlaceholder')}
        maxLength={60}
      />
      <div className="flex flex-col gap-2">
        {allowClear && !needle ? (
          <ChoiceRow name={name} checked={value === null} onSelect={() => onChange(null)}>
            <span className="text-body text-muted-foreground">
              {t('v3.categories.picker.none')}
            </span>
          </ChoiceRow>
        ) : null}
        {visible.map((parent) => (
          <div key={parent.id} className="flex flex-col gap-2">
            <ChoiceRow
              name={name}
              checked={value === parent.id}
              onSelect={() => onChange(parent.id)}
            >
              <CategoryChip name={parent.name} color={parent.color} className="self-start" />
            </ChoiceRow>
            {parent.children.map((child) => (
              <div key={child.id} data-depth="1" className="ps-6">
                <ChoiceRow
                  name={name}
                  checked={value === child.id}
                  onSelect={() => onChange(child.id)}
                >
                  <CategoryChip name={child.name} color={child.color} className="self-start" />
                </ChoiceRow>
              </div>
            ))}
          </div>
        ))}
        {canCreate ? (
          <Button
            type="button"
            variant="outline"
            className="justify-start"
            onClick={() => onCreate(query.trim())}
            disabled={busy}
          >
            <Plus className="me-1.5 size-4" aria-hidden="true" />
            {t('v3.categories.picker.create', { name: query.trim() })}
          </Button>
        ) : null}
      </div>
      <Link to={V3_ROUTES.categories} className="text-label text-primary hover:underline">
        {t('v3.categories.manage')}
      </Link>
    </fieldset>
  );
}
