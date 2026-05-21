'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Shared registry letting fixed top banners (UpdateBanner, InstallPromptBanner)
 * publish their on-screen height. The largest registered height is written to
 * the `--scani-banner-offset` CSS custom property on <html>; the toast viewport
 * reads it to sit below any visible banner instead of overlapping it.
 *
 * The max (not sum) is used deliberately: both banners are `fixed top-0` and
 * overlap each other in the rare both-visible case, so the occupied band is one
 * banner tall, not two.
 */
const heights = new Map<symbol, number>();

function publish(): void {
  if (typeof document === 'undefined') return;
  let max = 0;
  for (const height of heights.values()) {
    if (height > max) max = height;
  }
  const root = document.documentElement;
  if (max > 0) {
    root.style.setProperty('--scani-banner-offset', `${max}px`);
  } else {
    root.style.removeProperty('--scani-banner-offset');
  }
}

/**
 * Returns a callback ref to attach to a fixed top banner's root element. While
 * the element is mounted its height is tracked (via ResizeObserver) and
 * contributed to `--scani-banner-offset`.
 */
export function useBannerOffset<T extends HTMLElement = HTMLElement>(): (node: T | null) => void {
  const [key] = useState<symbol>(() => Symbol('banner'));
  const observerRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    return () => {
      heights.delete(key);
      observerRef.current?.disconnect();
      observerRef.current = null;
      publish();
    };
  }, [key]);

  return useCallback(
    (node: T | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;

      if (!node) {
        heights.delete(key);
        publish();
        return;
      }

      const measure = () => {
        heights.set(key, node.offsetHeight);
        publish();
      };
      measure();

      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(measure);
        observer.observe(node);
        observerRef.current = observer;
      }
    },
    [key]
  );
}
