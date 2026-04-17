import { useState } from 'react';
import { cn } from '@/lib/utils';

interface FaviconImgProps {
  /** Resolved favicon URL. Pass undefined/null when unavailable to render the fallback directly. */
  src?: string | null;
  /** Logical name of the entity. Used for alt text and the letter-fallback. */
  name: string;
  /** Classes applied to the <img>. */
  className?: string;
  /**
   * Letter-fallback classes when the image fails to load. If omitted, failed
   * images render nothing (previous behavior of inline onError hide).
   */
  fallbackClassName?: string;
}

/**
 * Small favicon wrapper that handles onError through React state instead of
 * imperative DOM mutation. Two behaviors:
 *  - no fallbackClassName → img disappears on error (matches most usages)
 *  - with fallbackClassName → shows a first-letter placeholder span on error
 */
export function FaviconImg({ src, name, className, fallbackClassName }: FaviconImgProps) {
  const [errored, setErrored] = useState(false);

  if (!src || errored) {
    if (fallbackClassName) {
      return (
        <span className={cn(fallbackClassName)} aria-hidden="true">
          {name.charAt(0).toUpperCase()}
        </span>
      );
    }
    return null;
  }

  return (
    <img src={src} alt={`${name} logo`} className={className} onError={() => setErrored(true)} />
  );
}
