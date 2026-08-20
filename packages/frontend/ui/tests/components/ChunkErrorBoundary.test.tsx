import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChunkErrorBoundary, ChunkLoadFallback } from '../../src/components/ChunkErrorBoundary';
import { ChunkLoadError } from '../../src/lib/lazy-chunk';

/**
 * The boundary that stands between a route chunk that would not load and a
 * white screen — the condition SC-132 attached to lifting the top-level-import
 * ban for frontend route splitting.
 *
 * The fallback is checked directly rather than by making React actually throw:
 * `renderToStaticMarkup` has no DOM, error boundaries do not catch during
 * server rendering, and this suite has no jsdom. What matters is that the markup
 * a broken load produces says something true and offers the one action that can
 * work — the boundary's own job is to route to it, and that is the second test.
 */

describe('ChunkLoadFallback', () => {
  const markup = renderToStaticMarkup(
    <ChunkLoadFallback chunk="classic interface" onReload={() => {}} />
  );

  it('names what is missing', () => {
    expect(markup).toContain('Could not load the classic interface');
  });

  it('offers the only action that can actually fix it', () => {
    // Not "go home": home is served by the same chunk, so that button
    // navigates the reader to the identical blank page.
    expect(markup).toContain('Reload the page');
    expect(markup).not.toContain('Dashboard');
  });

  it('explains the cause without blaming the reader or the app', () => {
    expect(markup).toContain('did not download');
    expect(markup).toContain('update that shipped while this tab was open');
  });

  it('takes its copy from the kit bundle rather than hard-coded English (SC-311)', () => {
    // i18next resolves a missing key to the key itself, silently — the same
    // failure SC-250 and SC-257 were both about, one layer along.
    expect(markup).not.toContain('ui.errors.chunk');
  });
});

describe('ChunkErrorBoundary', () => {
  it('renders children when nothing has gone wrong', () => {
    const markup = renderToStaticMarkup(
      <ChunkErrorBoundary chunk="interface">
        <p>the app</p>
      </ChunkErrorBoundary>
    );
    expect(markup).toBe('<p>the app</p>');
  });

  it('shows the fallback for a failed chunk and re-throws anything else', () => {
    // `render` is the whole decision, so it is exercised directly: React only
    // calls it with an error in state after `getDerivedStateFromError`, which
    // is a path a static render cannot reach.
    const boundary = new ChunkErrorBoundary({ chunk: 'interface', children: null });

    boundary.state = ChunkErrorBoundary.getDerivedStateFromError(
      new ChunkLoadError('interface', new Error('offline'))
    );
    expect(renderToStaticMarkup(boundary.render() as React.ReactElement)).toContain(
      'Could not load the interface'
    );

    // A real crash must reach the app's real error boundary and its reporting,
    // rather than being dressed up as a connectivity problem.
    const crash = new TypeError('x.map is not a function');
    boundary.state = ChunkErrorBoundary.getDerivedStateFromError(crash);
    expect(() => boundary.render()).toThrow(crash);
  });
});
