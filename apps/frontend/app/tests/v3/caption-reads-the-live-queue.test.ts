import { describe, expect, test } from 'bun:test';
import { commentSkipper } from '../../../../../packages/frontend/ui/tests/helpers/source-scan';
import { readV3Source } from './helpers/v3-sources';

/**
 * The one link in SC-1070's fix that a behavioural test cannot reach.
 *
 * `tests/v3/components/home.test.tsx` renders the whole composition — feed
 * rows, `pendingTransferCount`, `heroFigureQuality`, `<CoverageNote>` — with a
 * series row deliberately carrying a different number from the queue, and goes
 * red if the stored column ever reaches the sentence. What it cannot cover is
 * `HeroBlock` itself: the block owns two tRPC queries, so it does not render
 * without a client, and `pendingTransfers` is a plain `number` that
 * type-checks perfectly when handed the very value the fix exists to stop
 * using (`pnlSeries.data?.series.at(-1)?.transfersUnreviewed`).
 *
 * That is the shape this ticket was: a caption reading a plausible, correct,
 * WRONG number, where nothing failed and nothing was ill-typed. So the call
 * site is pinned as text — the same argument `token-hygiene` and `layout` make
 * for their scans, that a failure which type-checks, lints and renders needs a
 * check that is none of those three.
 *
 * It asserts the shape of the wiring, not the fix's correctness; the render
 * test owns that.
 */
const HERO = 'components/home/HeroBlock.tsx';

/** Prose about a symbol is not a use of it, and this file's whole subject is
 *  a block comment naming both of them (`mem_zb_ka1sdqdg`). */
async function heroCode(): Promise<string> {
  const isComment = commentSkipper();
  return (await readV3Source(HERO))
    .split('\n')
    .filter((line) => !isComment(line))
    .join('\n');
}

describe('the hero caption is wired to the live review queue', () => {
  test('HeroBlock reads the queue and hands it to the caption', async () => {
    const code = await heroCode();
    // The control: a file that failed to load, or a comment skipper that ate
    // everything, reads as absent for every symbol below and would pass three
    // assertions of the form "X is not here". Anchor on something that must
    // be present first.
    expect(code).toInclude('export function HeroBlock');

    expect(code).toInclude('useReviewFeed()');
    expect(code).toInclude('pendingTransfers: pendingTransferCount(');
  });

  test('it cannot assemble the caption from the series alone', async () => {
    const code = await heroCode();
    expect(code).toInclude('export function HeroBlock');

    // `heroFigureQuality` is the only door, and it is what makes the live
    // count a required argument rather than an optional improvement. Calling
    // `summariseQuality` here would reopen the choice at the call site, which
    // is where it was got wrong.
    expect(code).toInclude('heroFigureQuality(');
    expect(code).not.toInclude('summariseQuality(');
  });

  test('the stored 04:00 column is never read on this screen', async () => {
    const code = await heroCode();
    expect(code).toInclude('export function HeroBlock');

    // The mutation this whole file exists for: `transfersUnreviewed` is on
    // every PnL row on the wire, it is the number the caption used to show,
    // and reaching for it here type-checks.
    expect(code).not.toInclude('transfersUnreviewed');
  });
});
