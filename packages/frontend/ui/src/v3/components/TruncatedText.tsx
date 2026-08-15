import type { ReactNode } from 'react';
import { useOverflowTitle } from '../../hooks/useOverflowTitle';

/**
 * A line of text that hands over what it had to cut (SC-114).
 *
 * Anywhere v3 clips a string to fit — a row's identity line, a legend label, a
 * table cell — the clipped half was unreachable: no `title`, no tooltip, and on
 * `/accounts` the visible half ("Never — this accou…") read as an error when
 * the whole sentence was reassuring. This is that rule as one component, so a
 * new truncating surface gets it by using the same span everyone else does
 * rather than by remembering.
 *
 * It does not apply `truncate` itself: what a surface clips, and at what width,
 * is the surface's decision — this only makes the result recoverable. See
 * `useOverflowTitle` for why the attribute is measured rather than declared.
 */
export function TruncatedText({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const ref = useOverflowTitle<HTMLSpanElement>();
  return (
    <span ref={ref} className={className}>
      {children}
    </span>
  );
}
