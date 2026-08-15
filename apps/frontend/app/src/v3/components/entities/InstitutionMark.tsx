import { FaviconImg } from '@scani/ui/components/FaviconImg';
import { getFaviconUrl } from '@/lib/icons';
import { cn } from '@/lib/utils';

/**
 * An institution's mark, at a fixed size whether or not it has one.
 *
 * The fallback is not decoration. `FaviconImg` renders *nothing* without a
 * `fallbackClassName`, and an absent icon collapses the row's leading track to
 * zero — so a manually-created account sits 28px left of every other row and
 * the identity column stops being a column. The letter tile is the cheapest
 * thing that keeps the grid. Same component as `holdingsConfig`'s, lifted here
 * because accounts and institutions both need it and a third copy is where a
 * fourth comes from.
 */

interface InstitutionMarkProps {
  name: string;
  website?: string | null;
  /** A Tailwind size utility — `size-5` on a row, `size-4` in a table cell. */
  size: string;
}

export function InstitutionMark({ name, website, size }: InstitutionMarkProps) {
  return (
    <FaviconImg
      src={getFaviconUrl(website)}
      name={name}
      className={cn(size, 'shrink-0 rounded-sm object-contain')}
      fallbackClassName={cn(
        size,
        'flex shrink-0 items-center justify-center rounded-sm bg-surface-hover text-caption font-medium leading-none text-muted-foreground'
      )}
    />
  );
}
