import { formatDate, quantityDecimals } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import {
  answerLabel,
  basisQualityLabel,
  basisQualityNote,
  disposalVerb,
  groupDisposals,
  holdingPeriodLabel,
  outcomeNote,
  portionLabel,
  valuationLabel,
  valuationNote,
} from '../../lib/realized-ledger';
import { TRANSFER_REVIEW_PATH } from '../../lib/routes';

/**
 * The lots behind a holding's realized figure (SC-152).
 *
 * Realized PnL is a scalar everywhere it appears, so "why did my realized gain
 * change?" has been unanswerable: there is a number and nothing behind it. This
 * is the smallest surface that answers it — the disposals, and under each one
 * the acquisition lots it consumed, with what was paid and when.
 *
 * **It is not a tax surface and must not become one.** No "tax" in a heading,
 * a filename or a route; see `docs/technical/2026-08-14_why-no-tax-statement.md`
 * for why the word alone would lend an authority this data cannot support.
 *
 * What it deliberately does:
 *
 * - **Reports what did NOT happen.** Since SC-150 only a person's
 *   `left_control` answer books a gain, so an outflow can take its lots and
 *   move the figure by nothing. That is the harder half of the question, and a
 *   ledger of realizations alone would leave the lots visibly gone and the
 *   change unexplained.
 * - **Says whose answer each disposal rests on** (SC-324). `realized` on a
 ***REMOVED***
 ***REMOVED***
 *   figure is booked either way, so the row says which it is — otherwise the
 ***REMOVED***
 ***REMOVED***
 *   surface may answer by staying quiet.
 * - **Carries `basisQuality` to the lot** (SC-149). A gain derived from an
 *   import that reported itself truncated must say so *here*, next to the
 *   working — an explanation that looks more confident than the figure it
 *   explains is worse than the bare figure was.
 * - **Renders nothing when there is nothing.** Most holdings have never
 *   disposed of anything, and a titled empty block on every one of them is a
 *   surface that costs more than it pays.
 * - **Asks each quantity how precise it is** (SC-177). It shipped with a
 *   hardcoded `decimals={8}`, which is right for `0.05000000 BTC` and absurd
 *   for `500,000,000.00000000` of a memecoin — twenty characters, eight of
 *   them trailing zeros carrying no information, wrapping to three lines at
 *   390px. Eight is a ceiling, never a floor: `quantityDecimals` gives back
 *   the digits the figure actually has, which is what the holdings list two
 *   inches above and the transfer queue already render.
 *
 * Mounted only while the sheet is open — `peek.render` runs for the open record
 * alone — so a list of two hundred holdings issues no requests. The query is
 * computed on the read, with no table behind it.
 */

interface RealizedLedgerProps {
  holdingId: string;
  /** The user's base currency, as a symbol or ISO code. */
  currency: string;
  /** Ticker, used in the unit counts. */
  symbol: string;
}

/**
 * Which of the three lot sentences this slice gets.
 *
 * Three whole keys rather than one key plus two optional tails (SC-235): a
 * tail is only optional in a language that puts it last, and "held for 8
 * months" is a clause several of the eight put in front of the date.
 */
function lotSentenceKey(acquiredAt: string | null | undefined, held: string | null): string {
  if (!acquiredAt) return 'v3.holdings.realized.lotNoAcquisition';
  return held ? 'v3.holdings.realized.lotHeld' : 'v3.holdings.realized.lotAcquired';
}

export function RealizedLedger({ holdingId, currency, symbol }: RealizedLedgerProps) {
  const { t } = useTranslation();
  const ledger = trpc.holdings.realizedLedger.useQuery({ holdingId });

  const rows = ledger.data?.rows ?? [];
  // Silent on every failure mode, including the error one. This block explains
  // a figure that is rendered above it either way, so a red box here would
  // report the explanation's absence as a fault in the number.
  if (rows.length === 0) return null;

  const groups = groupDisposals(rows);
  const hasUnreviewed = groups.some((g) => g.outcome === 'unreviewed');

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-label font-medium">{t('v3.holdings.realized.heading')}</h3>
        <Numeric
          value={ledger.data?.realizedTotal ?? null}
          currency={currency}
          delta
          indicator="sign"
        />
      </div>

      <ol className="flex flex-col gap-3">
        {groups.map((group) => {
          const note = outcomeNote(group.kind, group.outcome, group.answerSource, t);
          const answerChip = answerLabel(group.kind, group.answerSource, t);
          // Rendered beside `note`, never instead of it: they answer different
          // questions (*whether* a gain was booked, and *from which price*),
          // and a swap that fell back is `realized` + unattributed-free, so
          // `outcomeNote` returns null on exactly the rows this speaks for.
          //
          // That last clause was a claim about the server rather than a
          // property of this file until SC-402 put the kind gate in both —
          // before it, a swap leg carrying a stale answer rendered the
          // provenance sentence ABOVE this one, so the row said "there is no
          // record of anyone answering it" and "valued from the token that
          // left" about the same number, one of them false.
          const valuation = valuationNote(group.kind, group.valuationBasis, t);
          const valuationChip = valuationLabel(group.kind, group.valuationBasis, t);
          const part = portionLabel(group, t);
          return (
            <li
              key={`${group.transactionId}#${group.portionIndex}`}
              className="flex flex-col gap-1.5 rounded-lg border border-border p-3"
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-body">
                  {disposalVerb(group.kind, t)}{' '}
                  <Numeric
                    value={group.quantity}
                    format="plain"
                    decimals={quantityDecimals(group.quantity)}
                  />{' '}
                  {symbol}
                </span>
                {group.gain === null ? (
                  <span className="text-caption text-muted-foreground">
                    {t('v3.holdings.realized.noGain')}
                  </span>
                ) : (
                  <Numeric value={group.gain} currency={currency} delta indicator="sign" />
                )}
              </div>
              <span className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
                <span>
                  {formatDate(group.disposedAt)}
                  {/* The division, on the row (SC-181). Two shares of one
                      withdrawal render adjacently and would otherwise read as
                      two withdrawals on the same day for different amounts —
                      which is a more confusing thing to see than the blended
                      row this replaced. */}
                  {part ? ` · ${part}` : ''}
                </span>
                {/* The chip, not just the sentence below it (SC-324). The
                    reader who opened this is scanning gains down a column, and
                    a caveat that only exists as prose in a paragraph they are
                    skipping is a caveat that is not on the screen. */}
                {answerChip ? <Badge variant="secondary">{answerChip}</Badge> : null}
                {valuationChip ? <Badge variant="secondary">{valuationChip}</Badge> : null}
              </span>
              {note ? <p className="text-caption text-muted-foreground">{note}</p> : null}
              {valuation ? <p className="text-caption text-muted-foreground">{valuation}</p> : null}

              <ul className="mt-1 flex flex-col gap-1.5 border-t border-border pt-2">
                {group.lots.map((lot, index) => {
                  const qualityLabel = basisQualityLabel(lot.basisQuality, t);
                  const held = holdingPeriodLabel(lot.holdingDays, t);
                  // A lot slice has no id of its own — it is a portion of a lot
                  // the FIFO walk consumed, not a record — so position is the
                  // only identity it has. Neither hazard the rule guards
                  // against applies: the list never reorders (the walk emits
                  // slices in consumption order) and these rows hold no state.
                  return (
                    <li
                      // biome-ignore lint/suspicious/noArrayIndexKey: see above — a lot slice has no id
                      key={`${lot.transactionId}-${index}`}
                      className="flex flex-col gap-0.5"
                    >
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="text-caption text-muted-foreground">
                          {/* One key per sentence, the quantity as a slot
                              (SC-235). The three cases were built by
                              concatenating " acquired {date}", " · held
                              {duration}" and " with no acquisition on record"
                              onto a rendered figure, so the quantity was
                              locked to the front of a sentence no language is
                              obliged to start there. */}
                          <Trans
                            i18nKey={lotSentenceKey(lot.acquiredAt, held)}
                            values={{
                              date: lot.acquiredAt ? formatDate(lot.acquiredAt) : '',
                              duration: held ?? '',
                            }}
                            components={{
                              qty: (
                                <Numeric
                                  value={lot.quantity}
                                  format="plain"
                                  decimals={quantityDecimals(lot.quantity)}
                                />
                              ),
                            }}
                          />
                        </span>
                        <span className="text-caption text-muted-foreground">
                          <Trans
                            i18nKey="v3.holdings.realized.costOf"
                            components={{
                              value: <Numeric value={lot.costBasis} currency={currency} />,
                            }}
                          />
                        </span>
                      </div>
                      {qualityLabel ? (
                        <span className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">{qualityLabel}</Badge>
                          <span className="text-caption text-muted-foreground">
                            {basisQualityNote(lot.basisQuality, t)}
                          </span>
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>

      {hasUnreviewed ? (
        // The one outcome a person can clear, so it gets the only link out.
        // Answering is what turns "no gain was booked" into a figure, and a
        // caveat with no route to its own resolution is just an apology.
        <Link
          to={TRANSFER_REVIEW_PATH}
          className="text-caption text-primary underline-offset-4 hover:underline"
        >
          {t('v3.realizedLedger.answerTransfers')}
        </Link>
      ) : null}
    </section>
  );
}
