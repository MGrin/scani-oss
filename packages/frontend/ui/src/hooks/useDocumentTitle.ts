import { useEffect, useState } from 'react';

/**
 * The tab, window, history and bookmark name of whatever is on screen (SC-996).
 *
 * Every route used to share the one `<title>` in `index.html`, so an installed
 * PWA's window, fifteen rows of browser history and every bookmark all read the
 * app's name and nothing else. The pages already rendered the right name in
 * their heading; this carries it to the document.
 *
 * **More than one component can claim the title at once, and the deepest wins.**
 * A peek opened over a list is a URL of its own (`/holdings/<id>`) while the
 * list page stays mounted underneath, so both want a say. Claims are ranked by
 * the order their owners first rendered — React renders a parent before its
 * children, and a peek opened later renders later still — so the record beats
 * the list whether it arrived by deep link or by tap, and closing it hands the
 * title back to the list rather than leaving the record's name on the tab.
 *
 * Nothing is restored when the last claim goes: the next route sets its own,
 * and writing the app's name back in between would flash it on every
 * navigation.
 */

export interface DocumentTitleTarget {
  title: string;
}

interface DocumentTitleClaims {
  claim: (order: number, page: string) => void;
  release: (order: number) => void;
  setBrand: (brand: string) => void;
}

export function formatDocumentTitle(page: string, brand: string): string {
  return `${page} · ${brand}`;
}

/** The ranking, without React or a DOM — the part a regression would break. */
export function createDocumentTitleClaims(
  target: () => DocumentTitleTarget | undefined,
  brand = 'Scani'
): DocumentTitleClaims {
  const claims = new Map<number, string>();
  let current = brand;

  const apply = () => {
    if (claims.size === 0) return;
    const page = claims.get(Math.max(...claims.keys()));
    const doc = target();
    if (page !== undefined && doc) doc.title = formatDocumentTitle(page, current);
  };

  return {
    claim(order, page) {
      claims.set(order, page);
      apply();
    },
    release(order) {
      claims.delete(order);
      apply();
    },
    setBrand(next) {
      current = next;
      apply();
    },
  };
}

const claims = createDocumentTitleClaims(() =>
  typeof document === 'undefined' ? undefined : document
);
let nextOrder = 0;

/** What follows the page name. `Scani` unless the app is not the product
 *  itself — the cloud console calls this once, before it renders. */
export function setDocumentTitleBrand(brand: string): void {
  claims.setBrand(brand);
}

/**
 * Names the document `<page> · Scani` while the caller is mounted.
 *
 * @param page the heading the caller renders, through the same i18n key, so
 *   the title is localized with it. `null` claims nothing — a peek that is
 *   closed, or still loading its record, leaves the list's title standing.
 */
export function useDocumentTitle(page: string | null): void {
  const [order] = useState(() => nextOrder++);

  useEffect(() => {
    if (page === null) return;
    claims.claim(order, page);
    return () => claims.release(order);
  }, [order, page]);
}
