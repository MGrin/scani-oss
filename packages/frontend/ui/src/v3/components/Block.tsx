import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../../lib/cn';

/**
 * A block of mixed content — §5.3 of the design brief's "one column, ruled".
 *
 * The rule the whole layout rests on is that *separation is earned*: a block of
 * mixed content gets a surface step and a hairline, while a run of rows of the
 * same shape gets a hairline and nothing else (`<DataRowList>`). v2 makes
 * everything a `Card`, which is why nothing on its dashboard reads as separate
 * from anything else.
 *
 * Elevation is surface-lift plus border, never shadow — a shadow does not read
 * on the dark page at all, and on the white one `--elevation-1` is spent on
 * things that actually float (sheets, popovers), not on a static block.
 */

interface BlockProps {
  children: ReactNode;
  className?: string;
}

export function Block({ children, className }: BlockProps) {
  return (
    <section
      // The figure line for everything inside it (SC-72). A block is the
      // innermost box in v3 whose width comes from the layout rather than from
      // its contents, which is exactly what a size container has to be — a
      // stat tile is usually a flex item sized *by* its own figure, so
      // declaring the line there collapses the tile instead of fitting the
      // figure. Padding sits on this element at almost every call site, so the
      // budget it publishes is the interior the figure actually gets.
      data-figure-line="true"
      className={cn('rounded-lg border border-border bg-surface-1', className)}
    >
      {children}
    </section>
  );
}

interface BlockHeaderProps {
  title: string;
  /** Where "See all" goes. Omitted when the block has nowhere further to go. */
  href?: string;
  /** The link's label. Sentence case, and it says where it goes. */
  action?: string;
}

export function BlockHeader({ title, href, action }: BlockHeaderProps) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
      <h2 className="text-title">{title}</h2>
      {href && action ? (
        <Link
          to={href}
          className={cn(
            'inline-flex items-center rounded-md px-2 py-1 text-label text-muted-foreground',
            'transition-colors duration-fast ease-emphasized hover:text-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background'
          )}
        >
          {action}
        </Link>
      ) : null}
    </div>
  );
}
