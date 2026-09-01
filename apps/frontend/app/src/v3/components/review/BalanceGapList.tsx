import type { BalanceGapList as BalanceGapListDto } from '@scani/shared';
import { balanceDecimals, formatDate } from '@scani/shared';
import { Block } from '@scani/ui/v3/components/Block';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { Trans, useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { BalanceGapAnswer } from './BalanceGapAnswer';

/**
 * Balance changes the ledger cannot explain (SC-501).
 *
 * A card per gap rather than a `V3DataView`, and the reason is the answer
 * control: this list is not something you sort and filter, it is a short
 * sequence of questions each carrying its own three-way control and a date
 * field. The queue is a few dozen rows on the heaviest production account and
 * it shrinks as it is worked.
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
  isLoading: boolean;
}

export function BalanceGapList({ data, isLoading }: BalanceGapListProps) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();

  // The two reads an answer moves, invalidated together: the queue itself and
  // the review feed whose badge counts it. A badge that still says 37 over a
  // queue of 12 is the disagreement `useReviewFeed` exists to prevent.
  const onAnswered = async () => {
    await Promise.all([
      utils.balanceGaps.listPending.invalidate(),
      utils.review.listPending.invalidate(),
    ]);
  };

  if (isLoading) return <p className="text-body">{t('v3.review.balances.loading')}</p>;
  if (!data) return null;

  const suppressedTotal = Object.values(data.suppressed).reduce((sum, n) => sum + n, 0);
  // `listPending` partitions every examined interval into exactly one of three
  // outcomes — shown, suppressed under a counted reason, or already answered —
  // and only the first two cross the wire. So this subtraction is exact, and
  // printing it is what keeps the line's arithmetic closed: `examined` counts
  // an answered `growth` or `unknown` (neither writes a ledger row, so the
  // interval still drifts and still arrives) while no suppression counter
  // does. Production reads 0 today because nobody has answered one yet, which
  // is exactly why the shortfall would have appeared later and looked like the
  // missed-rows bug the counts exist to rule out.
  const answered = Math.max(0, data.examined - data.items.length - suppressedTotal);

  return (
    <div className="flex flex-col gap-4">
      {/* Says what the list IS before what it is not (SC-576). The line led
          with "Showing 33 of 258 changes. 225 were left out", which puts the
          largest number in the sentence on the material the reader cannot see
          and reads as an admission — the counts are here to make the queue
          checkable, not to apologise for it. The provenance stays, one
          sentence down and in that order. */}
      {data.items.length > 0 ? (
        <p className="text-body">{t('v3.review.balances.queue', { count: data.items.length })}</p>
      ) : (
        <p className="text-body">{t('v3.review.balances.empty')}</p>
      )}

      <p className="text-label text-muted-foreground">
        {t(
          answered > 0 ? 'v3.review.balances.examinedWithAnswered' : 'v3.review.balances.examined',
          { examined: data.examined, suppressed: suppressedTotal, answered }
        )}
      </p>

      {data.items.map((gap) => (
        <Block key={gap.observationId} className="flex flex-col gap-3 p-4">
          <div className="flex items-baseline justify-between gap-4">
            <div className="flex flex-col">
              <span className="text-body font-medium">
                {gap.accountName
                  ? t('v3.review.balances.subject', {
                      account: gap.accountName,
                      symbol: gap.tokenSymbol,
                    })
                  : gap.tokenSymbol}
              </span>
              <span className="text-label text-muted-foreground">
                {/* `formatDate`, never a bare `toLocaleDateString()`. The
                    argument-less form takes the RUNTIME's locale, so this
                    sentence printed `5/17/2026` — American order — beside
                    figures the same card had already formatted for the chosen
                    language, and with Russian selected it read `Between
                    5/17/2026 and 6/27/2026 · 10 906,07`. That is SC-175 inside
                    one sentence: a translated frame with a device-formatted
                    date in it (SC-762). */}
                {t('v3.review.balances.between', {
                  from: formatDate(gap.from),
                  to: formatDate(gap.to),
                })}
              </span>
            </div>
            {/* Signed and toned: money arriving and money leaving are
                different questions and the reader should not have to read the
                two balances to tell which one they are being asked.

                Same `balanceDecimals` as the two readings below, and the
                agreement is the point — a delta of `−10,673.74` over a pair
                reading `232.33010646` is one movement described at two
                precisions, and a reader concludes one of them is lying.

                This is the one place the card overrides `<Numeric>`'s "a
                delta keeps its fixed two" rule, so the tension is worth
                naming: that rule exists so a change of `-0.004` is not
                reported as a loss with a red arrow, and it is stated for the
                DEFAULT of a currency delta. Here the caller chooses per token
                — and holding a crypto delta to two decimals is how `0.00021
                BTC` renders `−0.00`, which is the same claim-of-zero SC-567
                spent three commits removing. `moneyDecimals` still answers 2
                for every ordinary fiat figure, so nothing about the USD case
                moves. */}
            <Numeric
              value={gap.drift}
              format="plain"
              delta
              decimals={balanceDecimals(gap.drift, gap.tokenTypeCode)}
              className="text-figure"
            />
          </div>

          {/* `<Trans>` rather than `t()`, because the two readings are RENDERED
              FIGURES inside the sentence and not text (SC-576, same reasoning
              as `ConvertedTotal`). Interpolating them made the card print
              `10906.066301185 → 232.330106461 USD` beside a delta the same
              card had already formatted to `−10,673.74`.

              `balanceDecimals` and not one rule for every holding. The first
              fix used `quantityDecimals` throughout and printed
              `232.33010646 USD` under a delta of `−10,673.74` — correct for a
              coin count and wrong for currency, and three figures describing
              one movement at two precisions read as one of them lying. The
              rule now asks what the holding IS; `@scani/shared` owns it,
              because a second copy would be free to disagree. Neither branch
              can render a non-zero balance as `0`, which is what keeps SC-567
              closed at the render site as well as on the wire. */}
          <p className="text-label text-muted-foreground">
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
            {gap.transactionsApplied > 0
              ? ` ${t('v3.review.balances.partlyExplained', { count: gap.transactionsApplied })}`
              : ''}
          </p>

          <BalanceGapAnswer gap={gap} onAnswered={onAnswered} />
        </Block>
      ))}
    </div>
  );
}
