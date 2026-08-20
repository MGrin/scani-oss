import { Button } from '@scani/ui/ui/button';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { AnsweredTransferList } from '../components/review/AnsweredTransferList';
import { TRANSFER_REVIEW_PATH } from '../lib/routes';

/**
 * 100 rather than 25 (SC-244). The page size is not the fix — the honest empty
 * state is — but it is what makes the fix's escape hatch usable: 579 answered
 * rows is six presses of "Load more" rather than twenty-three.
 */
const PAGE_SIZE = 100;

/**
 * Transfers you have already answered (SC-181).
 *
 * The counterpart to the queue, and deliberately not part of it: the queue's
 * count reaching zero is the only feedback that working through it is
 * finishing, and a list holding every answered row can never reach zero. See
 * `TRANSFER_ANSWERED_PATH` for why it exists at all — 573 answers were given
 * in one bulk pass before an answer could apply to part of a transaction.
 *
 * Paged rather than capped (SC-241). The first version fetched one fixed page
 * of 200 with no way to ask for more, so for the user those 573 rows belong to,
 * 379 of them had no route at all.
 *
 * **The search is the server's** (SC-244): it used to narrow the page in hand
 * and report the result as an answer about every transfer the reader had ever
 * answered. The `answerSource` filter is still local and still sees only what
 * is loaded — `V3DataView` says so, on the count line and in the empty state,
 * and owns the "Load more" that widens it.
 */
export function AnsweredTransfersPage() {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const query = trpc.transferReview.listAnswered.useInfiniteQuery(
    { limit: PAGE_SIZE, search: search || undefined },
    {
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      // Or the list the reader is looking at vanishes into a skeleton on every
      // settled keystroke.
      keepPreviousData: true,
    }
  );

  const items = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.items),
    [query.data]
  );

  return (
    <PageLayout measure="wide">
      <PageHeader
        title={t('v3.review.answered.title')}
        action={
          <Button asChild variant="outline">
            <Link to={TRANSFER_REVIEW_PATH}>{t('v3.review.answered.backToQueue')}</Link>
          </Button>
        }
      />
      <AnsweredTransferList items={items} query={mergeQueries(query)} onSearch={setSearch} />
    </PageLayout>
  );
}
