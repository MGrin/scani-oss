import { SearchX } from 'lucide-react';
import { Button } from '../../../ui/button';
import type { ActiveFilter, EmptyStateSpec } from '../../lib/data-view';
import { describeFilteredEmpty } from '../../lib/data-view';

/**
 * The two empty screens, which are not the same screen.
 *
 * v2 rendered one — "No items found" with an inbox icon, and a description
 * that changed if filters were active while the title and the (absent) action
 * did not. But *nothing here yet* and *your filter matched nothing* want
 * different actions: the first wants the button that creates the first record,
 * the second wants the button that undoes the narrowing. Sharing a component
 * is what made them share an action, which is why v2's has none.
 *
 * v3-local rather than `@scani/ui`'s `EmptyState`: that one sets the icon at
 * `text-muted-foreground/50`, and the opacity modifier is exactly the
 * composite that fails contrast at `HoldingCard.tsx:99` (research brief §2.6).
 * v2 is not ours to change, so v3 draws its own.
 */

function Frame({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: EmptyStateSpec['icon'];
  title: string;
  description?: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <Icon className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        <p className="text-title">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-body text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function DataViewEmpty({ empty }: { empty: EmptyStateSpec }) {
  return (
    <Frame
      icon={empty.icon}
      title={empty.title}
      description={empty.description}
      action={empty.action}
    />
  );
}

export function DataViewFilteredEmpty({
  noun,
  searchTerm,
  activeFilters,
  onClearFilters,
}: {
  noun: string;
  searchTerm: string;
  activeFilters: ActiveFilter[];
  onClearFilters: () => void;
}) {
  const copy = describeFilteredEmpty(noun, searchTerm, activeFilters);

  return (
    <Frame
      icon={SearchX}
      title={copy.title}
      description={copy.description}
      action={
        <Button variant="outline" onClick={onClearFilters}>
          Clear search and filters
        </Button>
      }
    />
  );
}
