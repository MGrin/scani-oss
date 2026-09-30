import * as React from 'react';
import { cn } from '../lib/cn';

const FADE = '1rem';

/**
 * A sheet's scrolling region (UI standard rule 3, SC-1433).
 *
 * A body scrolled under a sheet's header cut its top line in half against the
 * header's rule, so content looked clipped rather than scrolled. Each edge
 * fades only while there is content past it: nothing fades at rest, so a body
 * with no top padding keeps its first line whole. Every sheet body scrolls
 * through this — the bottom drawer's, `FormSheet`'s and the desktop peek's.
 */
export const ScrollBody = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, style, onScroll, ...props }, forwardedRef) => {
    const ref = React.useRef<HTMLDivElement | null>(null);
    const [edges, setEdges] = React.useState({ top: false, bottom: false });

    const measure = React.useCallback(() => {
      const node = ref.current;
      if (!node) return;
      const top = node.scrollTop > 1;
      const bottom = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
      setEdges((current) =>
        current.top === top && current.bottom === bottom ? current : { top, bottom }
      );
    }, []);

    React.useEffect(() => {
      measure();
      const node = ref.current;
      if (!node || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      for (const child of Array.from(node.children)) observer.observe(child);
      return () => observer.disconnect();
    }, [measure]);

    const mask =
      edges.top || edges.bottom
        ? `linear-gradient(to bottom, ${edges.top ? 'transparent' : '#000'} 0, #000 ${FADE}, #000 calc(100% - ${FADE}), ${edges.bottom ? 'transparent' : '#000'} 100%)`
        : undefined;

    return (
      <div
        ref={(node) => {
          ref.current = node;
          if (typeof forwardedRef === 'function') forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }}
        className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', className)}
        style={{ maskImage: mask, WebkitMaskImage: mask, ...style }}
        onScroll={(event) => {
          measure();
          onScroll?.(event);
        }}
        {...props}
      />
    );
  }
);
ScrollBody.displayName = 'ScrollBody';
