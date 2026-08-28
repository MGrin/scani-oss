import '../../i18n-preload';

import { afterEach, describe, expect, test } from 'bun:test';
import {
  type BalanceGap,
  type BalanceGapList as BalanceGapListDto,
  resetFormatLocale,
  setFormatLocale,
} from '@scani/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { trpc } from '../../../src/lib/trpc';
import { BalanceGapList } from '../../../src/v3/components/review/BalanceGapList';

/**
 * The balance-review card, at the width it is read on (SC-576).
 *
 * SC-501 shipped this surface and it was browser-verified — on a desktop.
 * Nobody opened it at 393px, and what production got was four answer chips
 * collapsed into the single unreadable run `Money movFigure was wrongIt grew
 * I don't know`, above a sentence printing `10906.066301185 →
 * 232.330106461 USD` beside a delta the same card had formatted correctly.
 *
 * **This file cannot measure a layout** — `renderToStaticMarkup` has no box
 * model — so it does not pretend to. It guards the two decisions that made
 * the layout unfixable-by-accident, both of which a diff can silently undo:
 * the control's AXIS, and the fact that a figure passes through a formatter
 * before it reaches the DOM.
 */

const FIXTURE_PREVIOUS = '10906.066301185';
const FIXTURE_BALANCE = '232.330106461';

function gap(over: Partial<BalanceGap> = {}): BalanceGap {
  return {
    observationId: '11111111-1111-4111-8111-111111111111',
    holdingId: '22222222-2222-4222-8222-222222222222',
    tokenSymbol: 'USD',
    tokenTypeCode: 'fiat',
    accountName: 'IBKR Portfolio',
    from: '2026-05-17T09:00:00.000Z',
    to: '2026-06-27T09:00:00.000Z',
    // Full precision on purpose. A pre-rounded fixture renders identically
    // before and after this change, which is exactly how five number-rendering
    // defects reached production on other surfaces.
    previousBalance: FIXTURE_PREVIOUS,
    balance: FIXTURE_BALANCE,
    drift: '-10673.736194724',
    baseValue: '10673.736194724',
    baseCurrency: 'USD',
    transactionsApplied: 0,
    datePrompted: true,
    ...over,
  };
}

function listing(over: Partial<BalanceGapListDto> = {}): BalanceGapListDto {
  return {
    items: [gap()],
    examined: 258,
    suppressed: {
      'below-threshold': 200,
      'owner-stated': 15,
      reversed: 8,
      unpriceable: 2,
    },
    ...over,
  } as BalanceGapListDto;
}

function Harness({ children, client }: { children: ReactNode; client: QueryClient }) {
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: 'http://localhost/trpc' })],
  });
  return (
    <trpc.Provider client={trpcClient} queryClient={client}>
      <QueryClientProvider client={client}>
        <StaticRouter location="/review/balances">{children}</StaticRouter>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

function render(data: BalanceGapListDto = listing()): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  return renderToStaticMarkup(
    <Harness client={client}>
      <BalanceGapList data={data} isLoading={false} />
    </Harness>
  );
}

/** The rendered text, with tags and entities out of the way. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;| /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('BalanceGapList — the figures in the sentence', () => {
  test('a fiat balance is money, at money precision', () => {
    // The whole card describes one movement of one USD balance, so its three
    // figures have to agree: `−10,673.74` over `10,906.07 → 232.33`. The first
    // fix rendered `232.33010646` here and was rejected on sight for exactly
    // that — a reader seeing two precisions concludes one is wrong.
    const text = textOf(render());
    expect(text).toContain('10,906.07');
    expect(text).toContain('232.33');
    expect(text).not.toContain('232.33010646');
  });

  test('a crypto balance keeps the digits it carries', () => {
    // The other branch, and it must stay reachable: money-rounding a COUNT
    // turns a real position into a wrong number the reader cannot detect.
    const text = textOf(
      render(
        listing({
          items: [
            gap({
              tokenSymbol: 'BTC',
              tokenTypeCode: 'crypto',
              previousBalance: '0.05421',
              balance: '0.0104',
            }),
          ],
        })
      )
    );
    expect(text).toContain('0.05421');
    expect(text).toContain('0.0104');
  });

  test('a token type nobody has thought about yet falls to quantity precision', () => {
    // Named-money-positively, deliberately: a type an admin adds tomorrow is
    // far likelier to be a count than a currency, and the failure directions
    // are not symmetric. Too many decimals on a currency is ugly and honest;
    // rounding a count is a silent wrong number. Anyone flipping this default
    // has to argue with that, not just with the extra digits.
    const text = textOf(
      render(
        listing({
          items: [gap({ tokenTypeCode: 'some-type-invented-later', balance: '0.0104' })],
        })
      )
    );
    expect(text).toContain('0.0104');
  });

  test('never prints a raw wire decimal', () => {
    // The defect itself, stated as the thing that must not appear. SC-567 made
    // `balance` cross the wire at full precision deliberately, so the string
    // below is what the DTO legitimately carries — the bug was printing it.
    const text = textOf(render());
    expect(text).not.toContain(FIXTURE_PREVIOUS);
    expect(text).not.toContain(FIXTURE_BALANCE);
  });

  test('a dust balance is not rounded away to zero, on EITHER branch', () => {
    // The property SC-567 took three commits to establish, checked on the
    // fiat path too — which is the one that looks like it should round, and
    // is therefore the one a later simplification would break. `moneyDecimals`
    // extends past two rather than vanish, exactly as `quantityDecimals`
    // extends past eight.
    for (const code of ['fiat', 'crypto']) {
      const text = textOf(
        render(listing({ items: [gap({ tokenTypeCode: code, balance: '0.000000004218' })] }))
      );
      expect(text).toContain('0.000000004218');
      expect(text).not.toMatch(/→ 0\.00 /);
    }
  });

  test('the delta agrees with the readings under it', () => {
    // The card overrides `<Numeric>`'s fixed-two delta rule on purpose (see
    // the note at the call site). Held to two, a crypto delta renders `−0.00`
    // — the claim-of-zero, back again, on the largest figure on the card.
    const text = textOf(
      render(
        listing({
          items: [
            gap({
              tokenTypeCode: 'crypto',
              tokenSymbol: 'BTC',
              previousBalance: '0.05421',
              balance: '0.05400',
              drift: '-0.00021',
            }),
          ],
        })
      )
    );
    expect(text).toContain('0.00021');
    expect(text).not.toContain('−0.00 ');
  });
});

describe('BalanceGapList — the summary line', () => {
  test('leads with what the list is, not with what was hidden', () => {
    const text = textOf(render());
    const queue = text.indexOf('1 balance change to explain');
    const left = text.indexOf('were left out');
    expect(queue).toBeGreaterThanOrEqual(0);
    expect(left).toBeGreaterThan(queue);
  });

  test('accounts for every examined interval, including the answered ones', () => {
    // `examined` counts an interval whose owner answered `growth` or
    // `unknown` — neither writes a ledger row, so the interval still drifts
    // and still arrives — while no suppression counter does. 1 + 225 is 32
    // short of 258, and the line exists to be checkable arithmetic.
    //
    // WHY THIS TEST MUST KEEP MATTERING after the obvious follow-up: the
    // temptation is to make the server send an `answered` count instead of
    // deriving it. That is fine and this test still holds — it asserts the
    // NUMBER reaches the reader, not where it came from. What it refuses is
    // dropping the third bucket again, which reads as a query missing rows.
    const text = textOf(render());
    expect(text).toContain('Checked 258 in all');
    expect(text).toContain('225 were left out');
    expect(text).toContain('32 you have already answered');
  });

  test('says nothing about answered intervals when the partition is closed', () => {
    // Production reads zero here today, so a version of this component that
    // ALWAYS printed the clause would have looked right on the only data
    // anyone has seen. Both branches are covered for that reason.
    const closed = listing({
      examined: 226,
      items: [gap()],
      suppressed: {
        'below-threshold': 200,
        'owner-stated': 15,
        reversed: 8,
        unpriceable: 2,
      },
    } as Partial<BalanceGapListDto>);
    const text = textOf(render(closed));
    expect(text).toContain('Checked 226 in all');
    expect(text).not.toContain('already answered');
  });

  test('an empty queue says so instead of counting to zero', () => {
    const text = textOf(render(listing({ items: [] })));
    expect(text).toContain('Nothing to explain');
    expect(text).not.toContain('0 balance changes to explain');
  });
});

describe('BalanceGapAnswer — the axis of the answer control', () => {
  test('the four answers stack, at every width', () => {
    // The fix for the collision, asserted where a diff can see it. A row
    // divides the card by the option count and every label is nowrap, so a
    // label wider than its share paints over its neighbour — measured at
    // 393px as items of 77px carrying 83 / 95 / 77 / 79 of content.
    //
    // WHY THIS IS NOT A BREAKPOINT, and why relaxing it later would be
    // wrong: these labels are sentences and they are translated, so any
    // horizontal fit is chosen against English and is one translation away
    // from colliding again. A column has no share to overflow. Anyone
    // reverting this needs a reason that survives a longer language, not a
    // wider screen.
    expect(render()).toContain('data-segmented="vertical"');
  });

  test('every answer is still one option of a radio group', () => {
    // The column must not become four independent buttons: a radio group is
    // what announces "1 of 4" and gives arrow-key roving focus.
    const html = render();
    expect(html).toContain('role="radiogroup"');
    expect((html.match(/role="radio"/g) ?? []).length).toBe(4);
  });
});

describe('BalanceGapList — the date follows the CHOSEN language (SC-762)', () => {
  afterEach(resetFormatLocale);

  /**
   * The rendered card, not the formatter (SC-762).
   *
   * `formatDate` has been locale-aware since the `setFormatLocale` seam landed,
   * and a unit test on it passes either way — the defect this pins is a call
   * site that never asked it. `t('v3.review.balances.between')` interpolated a
   * bare `new Date(...).toLocaleDateString()`, which takes the RUNTIME's locale:
   * a translated sentence with a device-formatted date inside it, which is
   * SC-175 exactly. Only a render shows that, because the string is assembled
   * from a key and two arguments and no one of the three is wrong on its own.
   *
   * ## Why this asserts a PROPERTY and not the Russian text
   *
   * The first cut pinned the exact rendering and upstream CI failed on it:
   *
   *     this machine   Between 17 мая 2026 г. and 27 июня 2026 г.
   *     CI             Between 17 мая 2026 г. and 27 июн. 2026 г.
   *
   * Both are Russian and the fix works in both — **the two CLDR builds disagree
   * about the abbreviated month.** Pinning the literal tested this machine's ICU
   * rather than the behaviour, the same class as slice 1's finding that `en-XX`
   * region coverage differs between Bun and Chromium.
   *
   * Note which date exposed it: `17 мая 2026 г.` is IDENTICAL in both builds. A
   * fixture using only May would have been green on every runtime with the
   * fragility intact, so the two-date fixture is why this surfaced — and it was
   * not chosen for that reason.
   *
   * The frame stays English on purpose: only `en.json` is preloaded here, so
   * `t()` returns English while `formatDate` follows the chosen language. That
   * separation is the point — it isolates FORMATTING from TRANSLATION, and the
   * defect was formatting.
   */
  const between = (text: string): string => text.match(/Between .*?(?=↓)/)?.[0] ?? '';

  test('English renders the month-named form the whole card already uses', () => {
    setFormatLocale('en');
    // The deliberate English change this ticket ships, and the reason for it:
    // `5/17/2026` is 5 July or 7 May depending on which line you read it on.
    expect(between(textOf(render()))).toBe('Between 17 May 2026 and 27 Jun 2026');
  });

  test('choosing Russian changes the date, and changes it into Russian', () => {
    setFormatLocale('en');
    const english = between(textOf(render()));
    setFormatLocale('ru');
    const russian = between(textOf(render()));

    // DIFFERS is the property — an equality assertion on one language passes on
    // a card that ignores language entirely, because both arms then print the
    // runtime's `5/17/2026` and agree with each other.
    expect(russian).not.toBe(english);
    // …and differing is not enough on its own: this says it actually localised.
    // Day then a Cyrillic month, which matches `мая` and `июн.` alike, so it
    // holds across CLDR builds that disagree about abbreviation.
    expect(russian).toMatch(/Between \d+ [а-яё]/i);
  });

  test('and never the runtime’s numeric order, whichever language is chosen', () => {
    // The must-be-ABSENT arm, and it is the one that names the defect: `5/17/2026`
    // is what a bare `toLocaleDateString()` printed on this box, on a card whose
    // every other date reads `17 May 2026`.
    for (const language of ['en', 'ru']) {
      setFormatLocale(language);
      expect(textOf(render())).not.toContain('5/17/2026');
    }
  });
});
