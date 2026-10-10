import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { FigureVisibilityContext } from '../../../../src/v3/components/home/FigureVisibility';
import { HomeCard, HomePageStaleContext } from '../../../../src/v3/components/home/HomeCard';
import type { HomeCardQuery } from '../../../../src/v3/lib/home-card';

/** SC-1668: one card, every state. `renderToStaticMarkup` draws the first
 *  frame, which is the frame a person sees when the page opens. */

function q(overrides: Partial<HomeCardQuery> = {}): HomeCardQuery {
  return {
    isLoading: false,
    fetchStatus: 'idle',
    isFetching: false,
    isError: false,
    error: null,
    data: { ok: true },
    dataUpdatedAt: Date.UTC(2026, 9, 9, 14, 2),
    refetch: () => {},
    ...overrides,
  };
}

function card(queries: HomeCardQuery[], extra: { absent?: boolean; controls?: string } = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <HomeCard
        title="Vaults"
        subject="your vaults"
        queries={queries}
        absent={extra.absent}
        controls={extra.controls ? <span>{extra.controls}</span> : undefined}
        skeleton={<span>skeleton</span>}
      >
        {() => <p>Tax reserve</p>}
      </HomeCard>
    </MemoryRouter>
  );
}

describe('HomeCard', () => {
  test('loaded renders the header and the children, and no footer', () => {
    const html = card([q()]);
    expect(html).toInclude('Vaults');
    expect(html).toInclude('Tax reserve');
    expect(html).not.toInclude('As of');
  });

  test('error renders the header, an alert and Try again, and no children', () => {
    const html = card([
      q({ isError: true, data: undefined, error: { data: { httpStatus: 500 } } }),
    ]);
    expect(html).toInclude('Vaults');
    expect(html).toInclude('role="alert"');
    expect(html).toInclude('load your vaults');
    expect(html).toInclude('Try again');
    expect(html).not.toInclude('Tax reserve');
  });

  test('loading keeps the header and draws no children', () => {
    const html = card([q({ isLoading: true, fetchStatus: 'fetching', data: undefined })]);
    expect(html).toInclude('Vaults');
    expect(html).not.toInclude('Tax reserve');
  });

  test('absent renders nothing at all', () => {
    expect(card([q()], { absent: true })).toBe('');
  });

  test('a failed refetch keeps the children and says how old they are', () => {
    const html = card([q({ isError: true })]);
    expect(html).toInclude('Tax reserve');
    expect(html).toInclude('As of');
    expect(html).toInclude('Try again');
  });

  test('controls stay visible in the error state, so the cut can be changed', () => {
    const html = card([q({ isError: true, data: undefined })], { controls: 'By institution' });
    expect(html).toInclude('By institution');
    expect(html).toInclude('role="alert"');
  });

  test('under the page banner a stale card keeps its figures and adds no second retry', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HomePageStaleContext.Provider value={true}>
          <HomeCard
            title="Top holdings"
            subject="your top holdings"
            queries={[q({ isError: true })]}
            skeleton={<span>skeleton</span>}
          >
            {() => <p>GBP</p>}
          </HomeCard>
        </HomePageStaleContext.Provider>
      </MemoryRouter>
    );
    expect(html).toInclude('GBP');
    expect(html).not.toInclude('As of');
  });

  // SC-1669: a tile is the card shrunk to a title, one figure and one line,
  // and the whole of it opens the full card in a peek.
  function tile(queries: HomeCardQuery[], hidden = false) {
    return renderToStaticMarkup(
      <MemoryRouter>
        <FigureVisibilityContext.Provider
          value={{ hidden, settingHidden: hidden, toggle: () => {}, onPeek: undefined }}
        >
          <HomeCard
            variant="tile"
            peekId="vaults"
            title="Vaults"
            subject="your vaults"
            queries={queries}
            skeleton={<span>skeleton</span>}
            tile={() => ({ figure: <span>90%</span>, caption: 'Tax reserve' })}
            controls={<span>control</span>}
          >
            {() => <p>full card body</p>}
          </HomeCard>
        </FigureVisibilityContext.Provider>
      </MemoryRouter>
    );
  }

  test('a tile is one link to its peek, with its figure and caption', () => {
    const html = tile([q()]);
    expect(html.match(/<a /g)?.length).toBe(1);
    expect(html).toInclude('href="/home/vaults"');
    expect(html).toInclude('90%');
    expect(html).toInclude('Tax reserve');
    expect(html).not.toInclude('full card body');
  });

  test('a tile draws no controls and no buttons', () => {
    const html = tile([q()]);
    expect(html).not.toInclude('control');
    expect(html).not.toInclude('<button');
  });

  test('a failed tile still links to its peek and says it could not load', () => {
    const html = tile([q({ isError: true, data: undefined })]);
    expect(html).toInclude('href="/home/vaults"');
    expect(html).toMatch(/Couldn(&#x27;|')t load/);
    expect(html).not.toInclude('90%');
  });

  test('a stale tile says how old its figure is instead of its caption', () => {
    const html = tile([q({ isError: true })]);
    expect(html).toInclude('90%');
    expect(html).toInclude('As of');
    expect(html).not.toInclude('Tax reserve');
  });

  test('a hidden figure masks the tile value', () => {
    const hidden = tile([q()], true);
    // The figure and the caption, each masked: a caption carries money too.
    expect(hidden.match(/data-figure-masked/g)?.length).toBe(2);
    expect(tile([q()], false)).not.toInclude('data-figure-masked');
  });

  test('the peek variant draws the body with no card chrome and no header', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <HomeCard
          variant="peek"
          title="Vaults"
          subject="your vaults"
          queries={[q()]}
          skeleton={<span>skeleton</span>}
          controls={<span>control</span>}
        >
          {() => <p>full card body</p>}
        </HomeCard>
      </MemoryRouter>
    );
    expect(html).toInclude('full card body');
    expect(html).toInclude('control');
    expect(html).not.toInclude('<section');
    expect(html).not.toInclude('<h2');
  });
});

describe('an absent card', () => {
  const render = (variant: 'card' | 'peek') =>
    renderToStaticMarkup(
      <MemoryRouter>
        <HomeCard
          variant={variant}
          title="Debt"
          subject="your debt"
          queries={[q()]}
          absent
          skeleton={<span>skeleton</span>}
        >
          {() => <p>body</p>}
        </HomeCard>
      </MemoryRouter>
    );

  test('renders nothing on Home', () => {
    expect(render('card')).toBe('');
  });

  test('says so in a peek, which a shared link can open after the thing is gone', () => {
    expect(render('peek')).toInclude('Nothing to show here right now.');
  });
});
