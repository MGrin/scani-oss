import { figureFitStyle } from '@scani/ui/v3/lib/figure';
import { memo, useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { composeTape, rollFrom, type TapeCell, tapeCells } from '../../lib/tape';

/**
 * The net-worth hero — §5.4 of the design brief, and the only element in v3
 * that gets a signature treatment.
 *
 * Two things make it not just a big number:
 *
 * **It is composed, not printed.** The integer run carries the display size;
 * the currency symbol rides the top of its optical band and the cents ride the
 * bottom, both demoted to `caption` and muted — the cents on a six-figure net
 * worth are not the answer to "how much do I have", but removing them would be
 * a lie. Thousands take the locale's own separator in a cell narrower than a
 * digit — see `lib/tape.ts`, where SC-71 6.2 replaced the blank this used to
 * leave in its place.
 *
 * **Only the digits that changed move.** When the total actually changes —
 * a sync lands, the period toggle flips — each changed cell rolls one cell
 * vertically with a short left-to-right stagger, so the figure settles like a
 * mechanical counter. This is possible only because the face is monospaced:
 * fixed advance widths mean a digit is replaced in place with no reflow. The
 * discipline that keeps it from being decoration is that it fires on a real
 * change of value and nothing else — not on mount, not on a route change, not
 * on a refetch that returned the same number, and never on the digits that
 * did not move.
 */

/** Left-to-right, so the figure resolves like a counter rather than at once. */
const STAGGER_MS = 20;
/** Past this the tail of a long figure is still moving after the eye has left. */
const MAX_STAGGER_MS = 160;

interface GlyphProps {
  char: string;
  /** The glyph this cell is rolling away from, or `null` to render in place. */
  from: string | null;
  /** Changes on every real value change, which is what restarts the animation. */
  generation: number;
  delayMs: number;
}

/**
 * One cell. Memoised because a hero of nine digits re-renders nine leaves on
 * every parent render otherwise, and the outgoing glyph is mounted for the
 * duration of the animation — a re-render that remounts it mid-roll would
 * restart the roll.
 */
const TapeGlyph = memo(function TapeGlyph({ char, from, generation, delayMs }: GlyphProps) {
  const style = { animationDelay: `${delayMs}ms` };
  return (
    // `1ch` is the advance width of the face, so every cell is exactly one
    // digit wide whether it holds a 1 or a 0 — that is what lets a digit be
    // replaced without the figure reflowing. `overflow-hidden` clips the
    // outgoing glyph as it leaves.
    <span className="relative inline-block overflow-hidden text-center" style={{ width: '1ch' }}>
      {from === null ? null : (
        <span key={`out-${generation}`} className="v3-tape-roll-out absolute inset-0" style={style}>
          {from}
        </span>
      )}
      <span
        key={`in-${generation}`}
        className={from === null ? undefined : 'v3-tape-roll-in inline-block'}
        style={from === null ? undefined : style}
      >
        {char}
      </span>
    </span>
  );
});

interface TapeState {
  cells: TapeCell[];
  signature: string;
  previous: TapeCell[];
  generation: number;
}

function signatureOf(cells: readonly TapeCell[]): string {
  return cells.map((cell) => cell.char).join('');
}

interface NetWorthTapeProps {
  value: number | string | null | undefined;
  currency: string;
  className?: string;
}

export function NetWorthTape({ value, currency, className }: NetWorthTapeProps) {
  const parts = useMemo(() => composeTape(value, currency), [value, currency]);
  const cells = useMemo(() => tapeCells(parts), [parts]);
  const signature = signatureOf(cells);

  // The rendered figure is held in state rather than taken straight from the
  // props, because the roll needs both the new cells and the ones they
  // replaced. Seeding `previous` with the first cells is what keeps the hero
  // still on mount: there is no earlier figure, so nothing changed.
  const [state, setState] = useState<TapeState>(() => ({
    cells,
    signature,
    previous: cells,
    generation: 0,
  }));

  useEffect(() => {
    setState((current) =>
      current.signature === signature
        ? current
        : {
            cells,
            signature,
            previous: current.cells,
            generation: current.generation + 1,
          }
    );
  }, [signature, cells]);

  const rolling = useMemo(() => rollFrom(state.previous, state.cells), [state]);

  // What the fit rule needs to keep the hero inside the card (SC-72). The
  // integer run is the only part that scales, so it is measured in its own
  // cells — a glyph is one, a thousands separator is the 0.4 the render below
  // spends on it — while the symbol and the cents are `caption` and stay at 13px
  // whatever the run does. Those two are therefore an *inset*: width the run
  // never gets, rather than width that shrinks with it. Keeping them at the
  // caption size is deliberate — 13px is v3's floor, and a hero that has shrunk
  // to fit still owes its cents legibility.
  const runCells = state.cells.reduce(
    (total, cell) => total + (cell.kind === 'group' ? 0.4 : 1),
    0
  );
  const sideChars = parts.symbol.length + parts.decimal.length + parts.fraction.length;
  const inset = `calc(${sideChars} * 0.6 * var(--text-caption-size) + 0.25rem)`;

  let rollIndex = 0;

  return (
    <span className={cn('inline-flex', className)}>
      {/* The figure is a run of separately-positioned glyphs, which is not
          something to make a screen reader walk. It hears the ordinary
          formatted currency instead. */}
      <span className="sr-only">{parts.accessibleText}</span>
      {/* Two elements rather than one: the size role stays on the outer span so
          the fit rule's `1em` still means the display size, and the inner one
          carries the reduction. */}
      <span aria-hidden="true" className="font-display text-display">
        <span
          className="flex items-stretch"
          data-figure-fit="true"
          style={figureFitStyle(runCells, inset)}
        >
          {parts.isPlaceholder ? (
            <span className="text-muted-foreground">{parts.groups[0]}</span>
          ) : (
            <>
              {/* `items-stretch` on the row plus these two columns is what puts
                the symbol on the cap line and the cents on the baseline. The
                padding is in `em` of the *display* size, since that is the
                font-size these columns inherit. */}
              <span className="flex flex-col pr-1" style={{ paddingTop: '0.16em' }}>
                <span className="text-caption text-muted-foreground">{parts.symbol}</span>
              </span>

              {/* `items-end` rather than the default baseline alignment: an
                inline-block with `overflow: hidden` takes its bottom margin
                edge as its baseline, which would lift every digit cell off
                the line by a descender's depth. */}
              <span className="flex items-end">
                {state.cells.map((cell, index) => {
                  const from = rolling[index] ?? null;
                  const key = `${index}-${cell.kind}`;
                  if (cell.kind === 'group') {
                    // The locale's own separator, in a cell narrower than the
                    // monospaced advance width rather than omitted (SC-71 6.2).
                    //
                    // Two spans, and the inner one is not optional. The cell is
                    // `0.4ch` of the *display* size, so it has to be measured at
                    // that size; the glyph inside it is demoted to half, because a
                    // 44px comma carries a 44px advance and overhangs a 10px cell
                    // by enough to strike through the digit after it — which is
                    // what the first cut of this actually rendered. Demoting it
                    // also matches the hero's own composition, where the symbol
                    // and the cents are already caption-sized against the digits.
                    return (
                      <span
                        key={key}
                        className="inline-block text-center"
                        style={{ width: '0.4ch' }}
                      >
                        <span className="inline-block" style={{ fontSize: '0.5em' }}>
                          {cell.char}
                        </span>
                      </span>
                    );
                  }
                  const delayMs =
                    from === null ? 0 : Math.min(rollIndex++ * STAGGER_MS, MAX_STAGGER_MS);
                  return (
                    <TapeGlyph
                      key={key}
                      char={cell.char}
                      from={from}
                      generation={state.generation}
                      delayMs={delayMs}
                    />
                  );
                })}
              </span>

              {parts.fraction ? (
                <span className="flex flex-col justify-end" style={{ paddingBottom: '0.08em' }}>
                  <span className="text-caption text-muted-foreground">
                    {parts.decimal}
                    {parts.fraction}
                  </span>
                </span>
              ) : null}
            </>
          )}
        </span>
      </span>
    </span>
  );
}
