import { describe, expect, test } from 'bun:test';
import { LoadingRamp } from '@scani/ui/v3/components/feedback/LoadingRamp';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import type { LoadingPhase } from '@scani/ui/v3/lib/loading';
import { renderToStaticMarkup } from 'react-dom/server';

const SKELETON = <div data-testid="skeleton">rows</div>;

function ramp(phase: LoadingPhase, onRetry?: () => void): string {
  return renderToStaticMarkup(
    <LoadingRamp phase={phase} skeleton={SKELETON} label="holdings" onRetry={onRetry} />
  );
}

describe('LoadingRamp — what each band draws', () => {
  test('idle draws nothing, which is the point of the ramp', () => {
    expect(ramp('idle')).toBe('');
  });

  test('the 300ms band acknowledges without claiming a layout', () => {
    const html = ramp('indicator');
    expect(html).toInclude('v3-loading-rail');
    expect(html).not.toInclude('data-testid="skeleton"');
  });

  test('the skeleton arrives only past a second', () => {
    expect(ramp('skeleton')).toInclude('data-testid="skeleton"');
  });

  test('stalled still shows the placeholder, and says the wait is not normal', () => {
    const html = ramp('stalled', () => {});
    expect(html).toInclude('data-testid="skeleton"');
    expect(html).toInclude('Still waiting on the server');
    expect(html).toInclude('Try again');
  });

  /** The stall marker the CSS hangs the shimmer off — `Skeleton` in
   *  `@scani/ui` owns its own `animate-pulse` and is shared with v2, so the
   *  placeholder is quietened from the container rather than by giving the
   *  shared primitive a v3-only prop. */
  test('stalled marks the region so the shimmer can be stopped', () => {
    expect(ramp('stalled')).toInclude('data-v3-loading="stalled"');
    expect(ramp('skeleton')).toInclude('data-v3-loading="skeleton"');
  });
});

describe('LoadingRamp — the announcement', () => {
  /** One region, announced once, with every decorative shape hidden from it.
   *  A skeleton per-shape `aria-busy` makes a screen reader read rectangles. */
  test('is a single busy status region naming what is loading', () => {
    const html = ramp('skeleton');
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toInclude('aria-busy="true"');
    expect(html).toInclude('Loading holdings');
  });

  test('hides the placeholder itself from the accessibility tree', () => {
    for (const phase of ['indicator', 'skeleton'] as const) {
      expect(ramp(phase)).toInclude('aria-hidden="true"');
    }
  });

  test('the stalled notice is not hidden — it is the thing worth reading', () => {
    const html = ramp('stalled');
    const notice = html.slice(html.indexOf('Still waiting'));
    expect(notice).not.toInclude('aria-hidden');
  });
});

describe('QueryError', () => {
  test('states the failure, names the subject and offers a real retry', () => {
    const html = renderToStaticMarkup(
      <QueryError
        error={{ data: { httpStatus: 500 } }}
        subject="your holdings"
        onRetry={() => {}}
      />
    );
    expect(html).toInclude('load your holdings');
    expect(html).toInclude('Your data is untouched.');
    expect(html).toInclude('Try again');
    expect(html).toInclude('role="alert"');
    // A button, not a link to the current URL: retry has to be an action.
    expect(html).toInclude('<button');
  });

  test('a connection failure and a server failure do not read the same', () => {
    const offline = renderToStaticMarkup(
      <QueryError
        error={{ message: 'Failed to fetch' }}
        subject="your holdings"
        onRetry={() => {}}
      />
    );
    expect(offline).toInclude('reach the server');
    expect(offline).not.toInclude('load your holdings');
  });

  /** `border-border-strong`, not `border-border`: since V3-23 the plain token
   *  is the decorative hairline and owes no contrast floor, and the edge of an
   *  error panel is the one edge that must not be optional. */
  test('is drawn on the contrast-bearing border', () => {
    const html = renderToStaticMarkup(<QueryError error={null} subject="x" onRetry={() => {}} />);
    expect(html).toInclude('border-border-strong');
  });
});
