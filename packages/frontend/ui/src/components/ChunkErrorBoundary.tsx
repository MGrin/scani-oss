import { Component, type ErrorInfo, type ReactNode } from 'react';
import { uiT } from '../i18n';
import { isChunkLoadError } from '../lib/lazy-chunk';

/**
 * The boundary that stands between a chunk that would not load and a white
 * screen.
 *
 * It exists separately from `ErrorBoundary` because the recovery is different,
 * and getting that wrong is worse than not having one. `ErrorBoundary` offers
 * "go home" — correct for a component that threw, because a different screen
 * will render. For a **route chunk** that never arrived, home is served by the
 * same chunk, so that button navigates the reader into the identical blank
 * page. The only action that can work is fetching it again, which means a
 * reload.
 *
 * It must also sit *outside* the split it protects. v3's own `V3ErrorBoundary`
 * lives inside `V3App` — inside the chunk — so it cannot catch that chunk
 * failing to load. Nothing below a dynamic import can.
 *
 * A non-chunk error is re-thrown rather than absorbed, so the app's real error
 * boundary still owns real crashes and still reports them. This one is not a
 * catch-all wearing a friendlier hat.
 */

interface Props {
  children: ReactNode;
  /** Named in the message, so it says which part of the app is missing. */
  chunk: string;
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface State {
  error: Error | null;
}

/**
 * Exported for its own test: a boundary's fallback is the one path that only
 * renders when something has already gone wrong, so it is exactly the markup
 * least likely to be exercised by hand.
 */
export function ChunkLoadFallback({ chunk, onReload }: { chunk: string; onReload: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md space-y-4 text-center">
        <h1 className="text-2xl font-bold text-foreground">
          {uiT('ui.errors.chunk.title', { chunk })}
        </h1>
        {/* Two causes, both true, both actionable — and neither is "the app is
            broken", which is what a bare spinner or a blank page says. */}
        <p className="text-muted-foreground">{uiT('ui.errors.chunk.detail')}</p>
        <button
          type="button"
          onClick={onReload}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {uiT('ui.errors.chunk.reload')}
        </button>
      </div>
    </div>
  );
}

export class ChunkErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (!isChunkLoadError(error)) return;
    console.error('ChunkErrorBoundary caught:', error, info);
    this.props.onError?.(error, info);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    // Not ours. Hand it up rather than render a connectivity message over a
    // genuine crash — `render` is inside the boundary's own error path, so
    // throwing here propagates to the next boundary out.
    if (!isChunkLoadError(error)) throw error;
    return <ChunkLoadFallback chunk={this.props.chunk} onReload={() => window.location.reload()} />;
  }
}
