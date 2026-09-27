import '../../i18n-preload';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import i18next from 'i18next';
import {
  type JobNotice,
  type NoticeInput,
  type TransactionFetchContext,
  toJobNotice,
} from '../../../../../../packages/clients/providers/src/core/types';
import {
  type PageCapWalk,
  PageCapWatch,
} from '../../../../../../packages/clients/providers/src/core/utils/page-cap';
import {
  describeIncompleteCashRows,
  describeMissingSections,
  describeUnmappedCashTypes,
  TRANSACTION_SECTIONS,
} from '../../../../../../packages/clients/providers/src/providers/ibkr/statement-warnings';
import { readJobLines, renderJobLine } from '../../../src/v3/lib/job-results';

/**
 * The five list-bearing warnings SC-1028 keyed, rendered from what the real
 * producers emit, through the jsonb round trip, in every shipped locale.
 *
 * Two properties, and each needs the other to mean anything. In English the
 * rendered key must equal the producer's `text` byte for byte — that is what
 * proves `en.json` and the producer say the same sentence, and it is the
 * control for the second. In every other locale the render must NOT be the
 * English `text` and must carry no placeholder and no English clause — the
 * failure SC-1028 exists about is a translated frame around English prose,
 * and that renders as neither the fallback nor a clean translation.
 */

const LOCALES_DIR = join(import.meta.dir, '../../../src/v3/i18n/locales');
const LOCALES = readdirSync(LOCALES_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace(/\.json$/, ''));

const instance = i18next.createInstance();
await instance.init({
  lng: 'en',
  fallbackLng: false,
  interpolation: { escapeValue: false },
  resources: Object.fromEntries(
    LOCALES.map((code) => [
      code,
      { translation: JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), 'utf8')) },
    ])
  ),
});

function render(notice: JobNotice, language: string): string {
  // Through the stored shape: a job result is jsonb, and `readJobLines` is the
  // only thing between it and the screen.
  const stored = JSON.parse(JSON.stringify({ warnings: [notice.text], warningDetails: [notice] }));
  const [line] = readJobLines(stored);
  const t = instance.getFixedT(language);
  return renderJobLine(
    line!,
    (key, options) => t(key, options),
    (key, options) => instance.exists(key, { ...options, lng: language }),
    language
  );
}

function capture(run: (ctx: TransactionFetchContext) => void): JobNotice {
  const out: JobNotice[] = [];
  const sink = (reason: NoticeInput) => out.push(toJobNotice(reason));
  run({ retractHistoryClaim: sink, noteWarning: sink } as unknown as TransactionFetchContext);
  expect(out).toHaveLength(1);
  return out[0]!;
}

const EVERY_WALK: PageCapWalk[] = [
  { kind: 'addressHistory' },
  { kind: 'userTransactionsLedger' },
  { kind: 'cryptoTransactionsLookup' },
  { kind: 'accountList' },
  { kind: 'accountTransactions', account: 'acct-7' },
  { kind: 'symbolTrades', symbol: 'btcusd' },
  { kind: 'transfers' },
  { kind: 'currencyDeposits', currency: 'BTC' },
  { kind: 'currencyWithdrawals', currency: 'ETH' },
  { kind: 'feed', path: '/api/v1/accounts/ledgers' },
  { kind: 'trxTransfers' },
  { kind: 'trc20Transfers' },
];

function retracted(walks: PageCapWalk[]): JobNotice {
  return capture((ctx) => {
    const watch = new PageCapWatch();
    for (const walk of walks) watch.note({ walk, pages: 200, rows: 20_000 });
    watch.retract(ctx, 'coinbase');
  });
}

const CASES: Record<string, JobNotice> = {
  // Every kind appears alone once, so every clause key is rendered.
  ...Object.fromEntries(EVERY_WALK.map((w) => [`page cap: ${w.kind}`, retracted([w])])),
  'page cap: three named and one counted': retracted(EVERY_WALK.slice(0, 4)),
  'page cap: three named and nine counted': retracted(EVERY_WALK),
  'page cap: the annotation warning': capture((ctx) => {
    const watch = new PageCapWatch();
    watch.note({ walk: { kind: 'cryptoTransactionsLookup' }, pages: 200, rows: 200_000 });
    watch.warn(ctx, 'bitstamp', 'missingTxIds');
  }),
  'ibkr: one section missing': describeMissingSections([TRANSACTION_SECTIONS[1]!])!,
  'ibkr: both sections missing': describeMissingSections(TRANSACTION_SECTIONS)!,
  'ibkr: one unmapped type': describeUnmappedCashTypes(new Map([['Carbon Credits', 1]]))!,
  'ibkr: a long tail of unmapped types': describeUnmappedCashTypes(
    new Map([
      ['A', 9],
      ['B', 5],
      ['C', 3],
      ['D', 2],
      ['E', 1],
      ['F', 1],
    ])
  )!,
  'ibkr: one blank row': describeIncompleteCashRows(new Map([['currency', 1]]))!,
  'ibkr: blank rows of several shapes': describeIncompleteCashRows(
    new Map([
      ['currency', 2],
      ['amount', 2],
      ['type or currency or amount', 5],
    ])
  )!,
};

/** English clause text a partial translation would leak. */
const ENGLISH_TELLS = [
  'stopped at its',
  'further walk',
  'further type',
  'could be imported',
  'with no ',
  'never fetched',
  'transaction id',
  ' and ',
  ' or ',
];

describe('list-bearing job notices (SC-1028)', () => {
  test('every case carries lists — a notice with none would pass trivially', () => {
    for (const notice of Object.values(CASES)) {
      expect(notice.key).not.toBeNull();
      expect(Object.keys(notice.lists ?? {}).length).toBeGreaterThan(0);
    }
  });

  test('the locales read are the shipped set', () => {
    expect(LOCALES.sort()).toEqual(['ar', 'en', 'es', 'fr', 'id', 'ja', 'pt', 'ru', 'zh']);
  });

  for (const [name, notice] of Object.entries(CASES)) {
    test(`${name}: English renders the producer's sentence exactly`, () => {
      expect(render(notice, 'en')).toBe(notice.text);
    });

    for (const language of LOCALES.filter((l) => l !== 'en')) {
      test(`${name}: ${language} is translated whole`, () => {
        const out = render(notice, language);
        expect(out).not.toBe(notice.text);
        expect(out).not.toContain('{{');
        expect(ENGLISH_TELLS.filter((tell) => out.includes(tell))).toEqual([]);
      });
    }
  }

  test('one clause key this build does not carry falls back to the WHOLE English sentence', () => {
    const notice = CASES['page cap: three named and one counted']!;
    const [first, ...rest] = notice.lists!.walks!.items;
    const unknown: JobNotice = {
      ...notice,
      lists: {
        walks: {
          type: 'conjunction',
          items: [{ ...first!, key: 'v3.jobs.notices.notShippedYet' }, ...rest],
        },
      },
    };
    expect(render(unknown, 'ru')).toBe(notice.text);
  });

  test('a stored row whose lists are malformed renders its English sentence', () => {
    const notice = CASES['ibkr: both sections missing']!;
    const [line] = readJobLines({
      warnings: [notice.text],
      warningDetails: [{ ...notice, lists: { sections: { type: 'union', items: [] } } }],
    });
    expect(line).toEqual({ key: null, text: notice.text });
  });
});
