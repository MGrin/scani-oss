import '../../i18n-preload';
import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import { readGenericJobResult, readJobLines } from '../../../src/v3/lib/job-results';

/**
 * A warning the server keyed, read back on the client (SC-434).
 *
 * The stored payload is jsonb and this reader is the only thing between it
 * and the screen, so every case here is about what a row that is NOT the
 * happy shape does — 182 rows are already stored with no keys at all, and
 * they must keep rendering exactly what they render today.
 */
describe('readJobLines', () => {
  test('reads the plain array when no details are stored — the 182 already-stored rows', () => {
    expect(readJobLines({ warnings: ['binance: something happened'] })).toEqual([
      { key: null, text: 'binance: something happened' },
    ]);
  });

  test('carries the key and params when the server wrote them', () => {
    expect(
      readJobLines({
        warnings: ['binance: a run with no start date reaches 5 years back'],
        warningDetails: [
          {
            key: 'v3.jobs.notices.providerHorizon',
            params: { provider: 'binance', durationCount: 5, durationUnit: 'year' },
            text: 'binance: a run with no start date reaches 5 years back',
          },
        ],
      })
    ).toEqual([
      {
        key: 'v3.jobs.notices.providerHorizon',
        params: { provider: 'binance', durationCount: 5, durationUnit: 'year' },
        text: 'binance: a run with no start date reaches 5 years back',
      },
    ]);
  });

  test('ignores details wholesale when they do not line up with the text', () => {
    // Zipping a mismatched pair would attach one line's key to another
    // line's sentence — a confident WRONG sentence, where reading the
    // plain array gives a correct English one.
    expect(
      readJobLines({
        warnings: ['first', 'second'],
        warningDetails: [{ key: 'v3.jobs.notices.providerHorizon', text: 'first' }],
      })
    ).toEqual([
      { key: null, text: 'first' },
      { key: null, text: 'second' },
    ]);
  });

  test('drops a param that is not a primitive rather than sending it to the renderer', () => {
    const [line] = readJobLines({
      warnings: ['x'],
      warningDetails: [{ key: 'k', params: { good: 'a', n: 2, bad: { deep: 1 } }, text: 'x' }],
    });
    expect(line?.params).toEqual({ good: 'a', n: 2 });
  });

  test('a null key stays null — that is the honest case, not a gap', () => {
    expect(readJobLines({ warnings: ['x'], warningDetails: [{ key: null, text: 'x' }] })).toEqual([
      { key: null, text: 'x' },
    ]);
  });

  test('readGenericJobResult still counts an un-keyed warning toward isEmpty', () => {
    const view = readGenericJobResult({ warnings: ['x'] });
    expect(view?.isEmpty).toBe(false);
    expect(view?.warnings).toEqual([{ key: null, text: 'x' }]);
  });
});

/**
 * The sentences a Russian reader is shown (SC-434).
 *
 * This is the defect the ticket is about: the heading rendered "3 замечания"
 * and the sentence under it rendered in English. `getFixedT('ru')` is what
 * makes the assertion about what a reader SEES rather than about a key
 * existing — the preload registers the Russian bundle for exactly this.
 */
describe('the Russian reader', () => {
  const ru = i18n.getFixedT('ru');

  test('gets the horizon sentence in Russian, with a CLDR-correct unit', () => {
    const sentence = ru('v3.jobs.notices.providerHorizon', {
      provider: 'binance',
      durationCount: 5,
      durationUnit: 'year',
    });
    expect(sentence).toContain('binance');
    expect(sentence).toContain('5 лет');
    // Not the key echoed back, which is what i18next renders for a key it
    // cannot resolve — the failure this whole file exists to distinguish.
    expect(sentence).not.toBe('v3.jobs.notices.providerHorizon');
    expect(sentence).not.toContain('reaches');
  });

  test('gets 1 год rather than a plural form spliced from one key', () => {
    expect(
      ru('v3.jobs.notices.providerHorizon', {
        provider: 'kraken',
        durationCount: 1,
        durationUnit: 'year',
      })
    ).toContain('1 год');
  });

  test('gets a Russian frame around an upstream message that stays verbatim', () => {
    const sentence = ru('v3.jobs.notices.tokenIdentityFailed', {
      identity: 'evm:1:0xabc',
      error: 'CoinGecko rejected request: 429 Too Many Requests',
    });
    expect(sentence).toContain('Не удалось');
    // The tail is written by something outside this app and is quoted, not
    // translated. That is the answer for every upstream message, not a gap.
    expect(sentence).toContain('CoinGecko rejected request: 429 Too Many Requests');
  });

  /**
   * The four producers keyed by the migration half of SC-434.
   *
   * Each asserts three things, and the third is the one that matters: the
   * sentence is Russian, the identifiers inside it are untouched, and it is
   * NOT the English the server stored. Without that last arm a key that
   * silently fell back to English would pass the first two.
   */
  test('gets the wallet-pagination retraction in Russian, identifiers intact', () => {
    const sentence = ru('v3.jobs.notices.walletPaginationStopped', {
      provider: 'ethereum',
      streams: 'native, token',
      chainId: 1,
    });
    expect(sentence).toContain('постраничная загрузка');
    // The stream names are the API's own and stay as they are — that is what
    // made this sentence keyable in the first place.
    expect(sentence).toContain('native, token');
    expect(sentence).not.toContain('pagination stopped early');
  });

  test('gets the exited-positions warning in Russian', () => {
    const sentence = ru('v3.jobs.notices.reviewPaginationStopped', {
      streams: 'tokentx',
      chainId: 1,
    });
    expect(sentence).toContain('tokentx');
    expect(sentence).not.toContain('are not offered');
  });

  test('gets the unconfirmed-walk retraction in Russian', () => {
    const sentence = ru('v3.jobs.notices.walkUnconfirmed', { provider: 'kraken' });
    expect(sentence).toContain('kraken');
    expect(sentence).toContain('не подтвердил');
    expect(sentence).not.toContain('did not confirm');
  });

  test('gets the IBKR window retraction in Russian, ISO date and period intact', () => {
    const sentence = ru('v3.jobs.notices.ibkrStatementWindowPeriod', {
      from: '2025-08-29',
      period: 'Last365CalendarDays',
    });
    // A date and IBKR's own name for the range: both identifiers, neither
    // translated. Everything else is.
    expect(sentence).toContain('2025-08-29');
    expect(sentence).toContain('Last365CalendarDays');
    expect(sentence).toContain('отчёт Flex');
    expect(sentence).not.toContain('was never fetched');
  });

  test('the window branch with no period, and the one that cannot be read', () => {
    expect(ru('v3.jobs.notices.ibkrStatementWindow', { from: '2023-01-04' })).toContain(
      '2023-01-04'
    );
    const unknown = ru('v3.jobs.notices.ibkrStatementWindowUnknown');
    expect(unknown).toContain('не указывает');
    expect(unknown).not.toContain('does not say');
  });

  test('a key this build lacks is reported as absent, so the renderer shows the stored English', () => {
    // An older service worker, a locale not written yet, a result stored by
    // a newer server. `JobIssueList` asks this question and renders
    // `line.text` on a `false`, so the worst case of the mechanism is
    // exactly what shipped before it.
    expect(i18n.exists('v3.jobs.notices.notAKeyThisBuildHas')).toBe(false);
    expect(i18n.exists('v3.jobs.notices.providerHorizon')).toBe(true);
  });
});
