import type { JobNoticeList } from '../types';

/**
 * The English join a `JobNoticeList` renders as, so a producer's `text` is
 * the same sentence the client renders from `en.json`.
 *
 * Its own module rather than beside `JobNoticeList` in `types.ts`, because
 * `apps/frontend/cloud` type-checks `types.ts` under an ES2020 lib, which has
 * no `Intl.ListFormat`.
 */
export function englishList(list: JobNoticeList): string {
  return new Intl.ListFormat('en', { type: list.type }).format(list.items.map((i) => i.text));
}
