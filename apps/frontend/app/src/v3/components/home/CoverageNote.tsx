import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { FigureQuality } from '../../lib/home';
import { qualityHeadline, qualityOmissions, unreviewedTransfersNote } from '../../lib/home';
import { TRANSFER_REVIEW_PATH } from '../../lib/routes';

/**
 * How much of the figure above it is a measurement, and what was set aside to
 * arrive at that — two lines under the hero, in the reader's line of sight
 * rather than behind anything (SC-161).
 *
 * SC-146 fixed the coverage figure and put it on v2's chart as a chip; SC-149
 * and SC-151 added the two counts beside it. All three reached the rollup, the
 * API and both exports, and none of them reached **v3, which is the default
 * UI** — so the honest answer to "where is the priced percentage" was that it
 * existed everywhere except the screen its reader actually opens. It could be
 * had by exporting a file or switching back to v2.
 *
 * **Not v2's chip.** That is a coloured pill in a card header with the
 * explanation in a `title=` attribute, which on a phone is no explanation at
 * all — there is nothing to hover. Here the whole fact is the text, sized like
 * every other caption on the screen, and it is legible at 390px without a tap.
 *
 * **Directly under the figure, above the controls.** Coverage qualifies the
 * *number*, not the curve, so it sits where the number is rather than in the
 * caption band under the chart where `measuredThrough` lives — that one is
 * about the axis, and it is a different question.
 *
 * **Monochrome, and quieter when the news is good.** A full house is read in
 * muted ink; anything short of it darkens. Colour would have to compete with
 * the `<DeltaPill>` one line above, where green and red already mean something
 * specific about money, and v3 has no third tone that does not (`AttentionRow`
 * makes the same call, and notes that amber would read as "stale price" — which
 * here would be a claim about one of these three counts and not the others).
 *
 * **A third line, and a link (SC-160).** The unreviewed-transfer count is not
 * another clause in the omissions run, for two reasons. It is the only one
 * that says the figure is too LOW, and burying an opposite-signed fact in a
 * list a reader has learned to read as "these all flatter the number" is worse
 * than not saying it. And it is the only one they can *do* something about —
 * the review queue holds exactly those rows and answering them takes the count
 * to zero — so it gets the affordance that says so. The other three name
 * limits of what we could measure; nothing on this screen clears them.
 *
 * **Three lines at 390px, in the worst case, and that is the budget (SC-176).**
 * The PnL tab is the maximum — it adds `basisUnknown` and
 * `transfersUnreviewed` — and at 390px it had reached six wrapped lines
 * (~90px) under a ~55px figure. Nothing was dropped to fix that: all four
 * counts and the direction each of them errs in are still on screen without a
 * tap, which is the whole point of SC-161 and the one thing that could not be
 * traded away. What changed is where each fact sits and how many words it gets
 * — the unpriceable count moved up beside the denominator it explains
 * (`qualityHeadline`), the two remaining clauses were cut to what a reader
 * cannot infer, and the run and the link were made to wrap in shapes that
 * still read. Every line was measured in a 390px browser, not estimated: the
 * caption is 13px on a 327px content box, which is ~56 characters.
 */
export function CoverageNote({ quality }: { quality: FigureQuality }) {
  const { t } = useTranslation();
  const omissions = qualityOmissions(quality, t);
  const unreviewed = unreviewedTransfersNote(quality, t);

  return (
    <div className="flex flex-col gap-0.5">
      <span className={`text-caption ${quality.complete ? 'text-muted-foreground' : ''}`}>
        {qualityHeadline(quality, t)}
      </span>
      {omissions.length > 0 ? (
        // One clause per `whitespace-nowrap` span, with the separator OUTSIDE
        // them. `omissions.join(' · ')` was a single run of text, so the browser
        // broke it wherever the width ran out — which at 390px was mid-clause,
        // splitting "(the gain is an / upper bound)" across two lines and
        // leaving four visual lines with no way to see where one clause ended
        // and the next began. The `·` only separates anything while it is the
        // widest gap on the line. Now the only break opportunities are the
        // spaces around the separators, so a run too long for one line wraps
        // between clauses and each clause stays whole (SC-176).
        <span className="text-caption text-muted-foreground">
          {omissions.map((clause, index) => (
            <Fragment key={clause}>
              {index > 0 ? ' · ' : null}
              <span className="whitespace-nowrap">{clause}</span>
            </Fragment>
          ))}
        </span>
      ) : null}
      {unreviewed ? (
        // The whole sentence is the target, not a "review" word tacked onto the
        // end of it: at 390px a two-word tap target inside a caption is the one
        // thing on this block a thumb misses, and the sentence already names
        // where it goes.
        //
        // `text-balance` because that makes the underline's shape the sentence's
        // problem rather than the container's: if a three-digit count ever
        // pushes this to two lines it splits them evenly instead of orphaning
        // the last word under a full-width rule.
        <Link
          to={TRANSFER_REVIEW_PATH}
          className="text-caption text-balance text-muted-foreground underline"
        >
          {unreviewed}
        </Link>
      ) : null}
    </div>
  );
}
