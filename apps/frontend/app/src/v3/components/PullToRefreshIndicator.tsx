import { RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { PullPhase } from '../hooks/usePullToRefresh';

interface PullToRefreshIndicatorProps {
  phase: PullPhase;
  /** Pixels the indicator has travelled, straight from the gesture. */
  distance: number;
  /** 0–1 of the way to the trigger. */
  progress: number;
}

/** Chip height plus the gap above it, so it starts fully off the top edge. */
const CHIP_OFFSET = 44;

/**
 * The chip that rides in the gap the pull opens above the page (V3-34).
 *
 * Three things it says, in order: *something is happening* (it appears),
 * *let go now* (it fills with `--interactive`), *working* (it spins). The
 * middle one is the whole point of a pull gesture — without a distinct
 * armed state the user cannot tell how far is far enough, and the shape of
 * the pull has to be learned by trial.
 *
 * It travels from `-CHIP_OFFSET` — clipped by the wrapper, off the top edge —
 * to `distance - CHIP_OFFSET`, which keeps it inside the gap the content has
 * moved out of. Drawn at `distance` instead, it lands *on* the first thing on
 * the page, which on the home screen is the net-worth figure.
 *
 * Motion policy (§2.4): the arrow's rotation while pulling is not an
 * animation, it is the finger's position drawn on a dial — it stops the
 * instant the finger does and is correct under reduced motion. The two real
 * animations are guarded: the settle transition runs on `duration-base`,
 * which the v3 token layer collapses to 0ms under
 * `prefers-reduced-motion: reduce`, and the spinner lives behind a
 * `no-preference` query in `v3-motion.css`. Under reduced motion the
 * refreshing state is a still, filled chip — the same trade the loading rail
 * makes when it becomes a static fill.
 */
export function PullToRefreshIndicator({ phase, distance, progress }: PullToRefreshIndicatorProps) {
  const { t } = useTranslation();
  const visible = phase !== 'idle';
  const armed = phase === 'ready' || phase === 'refreshing';
  const following = phase === 'pulling' || phase === 'ready';

  return (
    <>
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center',
          'ease-emphasized duration-base',
          // While the finger is down the chip must be exactly where the
          // finger put it; a transition on `transform` here would render the
          // pull as a lag. It is only on the way back that easing is wanted.
          following ? 'transition-opacity' : 'transition-[transform,opacity]'
        )}
        style={{
          transform: `translateY(${distance - CHIP_OFFSET}px)`,
          opacity: visible ? 1 : 0,
        }}
      >
        <div
          className={cn(
            'flex h-9 w-9 items-center justify-center rounded-full border transition-colors duration-fast ease-emphasized',
            armed
              ? 'border-transparent bg-interactive text-interactive-foreground'
              : 'border-border-strong bg-surface-1 text-muted-foreground'
          )}
        >
          <RefreshCw
            aria-hidden="true"
            className={cn('h-4 w-4', phase === 'refreshing' && 'v3-pull-spin')}
            style={
              phase === 'refreshing' ? undefined : { transform: `rotate(${progress * 270}deg)` }
            }
          />
        </div>
      </div>
      {/* Announced separately from the chip, which is decorative: a screen
          reader user gets no gesture feedback from a rotating arrow. */}
      <span aria-live="polite" className="sr-only" role="status">
        {phase === 'refreshing' ? t('v3.common.pullToRefresh.refreshing') : ''}
      </span>
    </>
  );
}
