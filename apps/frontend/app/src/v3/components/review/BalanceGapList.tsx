import type { BalanceGap, BalanceGapList as BalanceGapListDto } from '@scani/shared';
import { balanceDecimals, formatDate } from '@scani/shared';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { Scale } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { BALANCE_GAP_REVIEW_PATH } from '../../lib/routes';
import { Callout } from '../Callout';
import { ExplainGapAction } from './BalanceGapAnswer';

/**
 * Balance changes the ledger cannot explain (SC-501).
 *
 * A `V3DataView` like every other queue (SC-1433): a row per gap, its peek,
 * and an Explain action there that opens the answer as a `FormSheet`.
 * Until SC-1433 it was a card per gap with the whole answer form open inside
 * each card, which made the page the one list in the app that edited its rows
 * in place.
 *
 * ## The line that says what was left out
 *
 * `examined` and `suppressed` are printed, not logged. A queue drawn from a
 * stated number of candidates is trustworthy in a way that the same queue drawn
 * from nowhere in particular is not — and the specific failure this guards against
 * is a query that silently misses rows, which is indistinguishable from a
 * suppression rule doing its job unless the counts are on screen. The reader
 * is also the only person who knows whether the thing that was suppressed
 * mattered.
 *
 * **These counts are PER USER, and mistaking that for the product-wide figure
 * cost a ticket (SC-576).** The threshold note in `@scani/shared` records the
 * gap population at ≥250 USD *across every user*. A per-account count was read
 * as the queue having grown past what SC-501 measured; measured on production
 * 2026-08-22 the per-user counts sum to exactly that product-wide population,
 * so the page was rendering one user's share of what the threshold was designed
 * for. Nothing about the threshold had moved. Before proposing a number here, check which population the
 * number you are comparing against was drawn from.
 */
interface BalanceGapListProps {
  data: BalanceGapListDto | undefined;
  query: V3QueryState;
}

export function BalanceGapList({ data, query }: BalanceGapListProps) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const navigate = useNavigate();

  // The two reads an answer moves, invalidated together: the queue itself and
  // the review feed whose badge counts it. A badge that still says 37 over a
  // queue of 12 is the disagreement `useReviewFeed` exists to prevent.
  const onAnswered = async () => {
    await Promise.all([
      utils.balanceGaps.invalidate(),
      utils.transferReview.invalidate(),
      utils.portfolio.invalidate(),
      utils.review.listPending.invalidate(),
    ]);
    navigate(BALANCE_GAP_REVIEW_PATH);
  };

  const items = data?.items ?? [];
  const subject = (gap: BalanceGap) =>
    gap.accountName
      ? t('v3.review.balances.subject', { account: gap.accountName, symbol: gap.tokenSymbol })
      : gap.tokenSymbol;
  // `formatDate`, never a bare `toLocaleDateString()`. The argument-less form
  // takes the RUNTIME's locale, so this sentence printed `5/17/2026` beside
  // figures already formatted for the chosen language (SC-762).
  const between = (gap: BalanceGap) =>
    t('v3.review.balances.between', { from: formatDate(gap.from), to: formatDate(gap.to) });
  // Signed and toned, at the token's own precision. `balanceDecimals` keeps a
  // crypto delta from rendering `−0.00` (SC-567) and agrees with the two
  // readings in the peek, so one movement is never shown at two precisions.
  const drift = (gap: BalanceGap) => (
    <Numeric
      value={gap.drift}
      format="plain"
      delta
      decimals={balanceDecimals(gap.drift, gap.tokenTypeCode)}
    />
  );

  const config: V3DataViewConfig<BalanceGap> = {
    pageKey: 'balance-gaps',
    data: items,
    nounKey: 'ui.dataView.noun.balanceChanges',
    searchPlaceholderKey: 'ui.dataView.balanceGaps.config.search',
    searchFn: (gap, term) =>
      `${gap.accountName ?? ''} ${gap.tokenSymbol}`
        .toLocaleLowerCase()
        .includes(term.toLocaleLowerCase()),
    renderRow: (gap) => ({
      label: subject(gap),
      sublabel: between(gap),
      value: drift(gap),
      ariaLabel: `${subject(gap)}, ${between(gap)}`,
    }),
    columns: [
      {
        key: 'subject',
        headerKey: 'ui.dataView.balanceGaps.col.change',
        render: (gap) => <span className="truncate text-label">{subject(gap)}</span>,
      },
      {
        key: 'between',
        headerKey: 'ui.dataView.balanceGaps.col.when',
        render: (gap) => <span className="truncate text-muted-foreground">{between(gap)}</span>,
      },
      {
        key: 'drift',
        headerKey: 'ui.dataView.balanceGaps.col.drift',
        numeric: true,
        render: drift,
      },
    ],
    // What the list IS, then how it was drawn (SC-576): the largest number in
    // the block is the queue, not the material the reader cannot see.
    summary: () => (
      <Callout icon={Scale}>
        <p>{t('v3.review.balances.queue', { count: items.length })}</p>
        <p className="text-muted-foreground">{t('v3.review.balances.intro')}</p>
        {data ? <p className="text-muted-foreground">{examinedLine(t, data)}</p> : null}
      </Callout>
    ),
    empty: {
      icon: Scale,
      titleKey: 'ui.dataView.balanceGaps.empty.nothingToExplain',
      descriptionKey: 'ui.dataView.balanceGaps.empty.everyChangeIsAccountedFor',
      // Nothing to create from a queue (rule 8, SC-1433).
      action: null,
    },
    peek: {
      basePath: BALANCE_GAP_REVIEW_PATH,
      render: (gap) => ({
        title: subject(gap),
        subtitle: between(gap),
        value: drift(gap),
        primary: [
          {
            label: t('v3.review.balances.balanceLabel'),
            // `<Trans>` because the two readings are RENDERED FIGURES inside
            // the sentence (SC-576), each at the precision the holding needs.
            value: <BalanceGapReadings gap={gap} />,
          },
        ],
        // Answering is what the reader opened the row to do, so it is the
        // peek's first action and opens the answer sheet (rules 4 and 13).
        actions: <ExplainGapAction gap={gap} onAnswered={onAnswered} />,
      }),
    },
  };

  return <V3DataView config={config} getId={(gap) => gap.observationId} query={query} />;
}

/**
 * The two readings either side of the change, and how much of it transactions
 * already explain — the peek's one fact.
 *
 * `<Trans>` because the readings are RENDERED FIGURES inside the sentence
 * (SC-576), each at the precision the holding needs: `balanceDecimals` asks
 * what the holding IS, so a currency reads `10,906.07 → 232.33` beside a
 * `−10,673.74` delta and a coin keeps its digits. Neither branch can render a
 * non-zero balance as `0` (SC-567).
 */
export function BalanceGapReadings({ gap }: { gap: BalanceGap }) {
  const { t } = useTranslation();
  return (
    <span className="flex flex-col gap-0.5">
      <span>
        <Trans
          i18nKey="v3.review.balances.balances"
          values={{ symbol: gap.tokenSymbol }}
          components={{
            previous: (
              <Numeric
                value={gap.previousBalance}
                format="plain"
                decimals={balanceDecimals(gap.previousBalance, gap.tokenTypeCode)}
              />
            ),
            current: (
              <Numeric
                value={gap.balance}
                format="plain"
                decimals={balanceDecimals(gap.balance, gap.tokenTypeCode)}
              />
            ),
          }}
        />
      </span>
      {gap.transactionsApplied > 0 ? (
        <span className="text-caption text-muted-foreground">
          {t('v3.review.balances.partlyExplained', { count: gap.transactionsApplied })}
        </span>
      ) : null}
    </span>
  );
}

/**
 * `listPending` partitions every examined interval into exactly one of three
 * outcomes — shown, suppressed under a counted reason, or already answered —
 * and only the first two cross the wire. So this subtraction is exact, and
 * printing it is what keeps the line's arithmetic closed: `examined` counts an
 * answered `growth` or `unknown` (neither writes a ledger row, so the interval
 * still drifts and still arrives) while no suppression counter does.
 */
function examinedLine(t: ReturnType<typeof useTranslation>['t'], data: BalanceGapListDto): string {
  const suppressed = Object.values(data.suppressed).reduce((sum, n) => sum + n, 0);
  const answered = Math.max(0, data.examined - data.items.length - suppressed);
  return t(
    answered > 0 ? 'v3.review.balances.examinedWithAnswered' : 'v3.review.balances.examined',
    { examined: data.examined, suppressed, answered }
  );
}
