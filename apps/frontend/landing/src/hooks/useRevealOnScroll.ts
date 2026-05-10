import { useEffect, useRef } from 'react';

/**
 * Adds `data-revealed="true"` to the returned ref'd element the first
 * time it scrolls into view. CSS keyframes keyed off that attribute
 * (see `src/index.css`) animate the element in.
 *
 * Why a hook (not a component wrapper): the section components already
 * render their own `<section>` element — we just want to attach the
 * observer + attribute toggle, not introduce another DOM node.
 *
 * Each observer fires once. Once `data-revealed` is set, we unobserve;
 * scrolling back up won't re-trigger the animation, which keeps the
 * page calm and consistent with how anchor links land.
 *
 * Disabled entirely under `prefers-reduced-motion: reduce` — the CSS
 * gate at the `[data-revealed]` selector ensures the animation never
 * runs, and we also skip the observer to avoid wasted work.
 */
export function useRevealOnScroll<T extends HTMLElement>(options?: {
  threshold?: number;
  rootMargin?: string;
}) {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') {
      el.dataset.revealed = 'true';
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.dataset.revealed = 'true';
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.setAttribute('data-revealed', 'true');
            observer.unobserve(entry.target);
          }
        }
      },
      {
        threshold: options?.threshold ?? 0.1,
        rootMargin: options?.rootMargin ?? '0px 0px -10% 0px',
      }
    );

    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [options?.threshold, options?.rootMargin]);

  return ref;
}
