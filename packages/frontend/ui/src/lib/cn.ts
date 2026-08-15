import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * tailwind-merge only knows the class groups Tailwind ships with. The v3 type
 * roles (`text-display` … `text-caption`, added to `fontSize` in
 * tailwind-preset.js) are not among them, so out of the box it files them under
 * *text colour* — the only other group `text-*` can belong to — and then
 * silently deletes them whenever a real colour is merged in after:
 * `cn('text-caption', 'text-muted-foreground')` returned just
 * `text-muted-foreground`.
 *
 * That is a size vanishing with no error and no visual clue beyond "this line
 * looks a bit big", which is the kind of bug that ships. Registering the five
 * roles under `font-size` is the whole fix; they then conflict with each other
 * and with `text-xs`/`text-sm`, and with nothing else.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['display', 'title', 'body', 'label', 'caption'] }],
    },
  },
});

/**
 * Conditional className merger used across every shadcn primitive. Relies
 * on `clsx` for falsy-value filtering + `tailwind-merge` to de-dupe
 * conflicting utility classes (e.g. `p-2 p-4` → `p-4`).
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
