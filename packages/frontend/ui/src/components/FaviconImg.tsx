import { useState } from 'react';
import { uiT } from '../i18n';
import { cn } from '../lib/cn';

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
 *  - with fallbackClassName → shows a first-letter placeholder span on error,
 *    and while the image is still loading: an icon in flight otherwise leaves
 *    an empty box in the row's mark (SC-1699)
 */
export function FaviconImg({ src, name, className, fallbackClassName }: FaviconImgProps) {
  const [errored, setErrored] = useState(false);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const letter = fallbackClassName ? (
    <span className={cn(fallbackClassName)} aria-hidden="true">
      {name.charAt(0).toUpperCase()}
    </span>
  ) : null;

  if (!src || errored) return letter;

  const loaded = loadedSrc === src;
  return (
    <>
      {loaded ? null : letter}
      <img
        src={src}
        alt={uiT('ui.brand.logoAlt', { name })}
        className={cn(className, letter && !loaded && 'hidden')}
        onLoad={() => setLoadedSrc(src)}
        onError={() => setErrored(true)}
      />
    </>
  );
}
