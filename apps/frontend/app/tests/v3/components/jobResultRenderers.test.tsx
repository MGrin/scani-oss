import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { ExchangeImportResult } from '@/v3/components/jobs/ExchangeImportResult';
import { FileImportResult } from '@/v3/components/jobs/FileImportResult';
import { GenericJobResult } from '@/v3/components/jobs/GenericJobResult';
import { WalletImportResult } from '@/v3/components/jobs/WalletImportResult';
import { resolveV3ReviewRenderer } from '@/v3/lib/job-result';

/**
 * The job-result renderers, on the branches a static render can reach — the
 * ones that mount no tRPC hook. Everything behind a mutation (the wallet
 * picker, the currency prompt, the pre-review holdings table) has its rules in
 * `tests/v3/lib/`, where they are pure and assertable without a DOM.
 */

function render(node: ReactNode): string {
  return renderToStaticMarkup(<StaticRouter location="/jobs/job-1">{node}</StaticRouter>);
}

describe('the v3 registry', () => {
  test('owns every entry rather than delegating any of them', () => {
    // SC-320 slice 6: `job-result.tsx` was the last v3 file importing from v2,
    // and the import survived as long as ONE entry was still delegated.
    for (const kind of [
      'wallet-import',
      'exchange-import',
      'screenshot-parse',
      'file-import',
      'document-parse',
      'manual-holdings-create',
    ]) {
      expect(resolveV3ReviewRenderer(kind).kind).toBe(kind);
    }
  });

  test('an unknown job kind lands on the fallback rather than throwing', () => {
    expect(resolveV3ReviewRenderer('holding-price-update').kind).toBe('__fallback__');
    expect(resolveV3ReviewRenderer('a-kind-shipped-tomorrow').kind).toBe('__fallback__');
  });
});

describe('ExchangeImportResult', () => {
  test('offers the way to the holdings even when nothing was imported', () => {
    // v2 gates the link on `tokensImported > 0`, so an account that connected
    // and reported no balances — the case its own copy calls normal — leaves
    // the reader on two zeroes with nowhere to go.
    const html = render(
      <ExchangeImportResult result={{ accountsCreated: 2, tokensImported: 0, errors: [] }} />
    );
    expect(html).toContain('View holdings');
    expect(html).toContain('connected and the provider returned no balances');
  });

  test('names what was cut from a truncated error list', () => {
    const errors = Array.from({ length: 13 }, (_, i) => ({ error: `failure ${i}` }));
    const html = render(<ExchangeImportResult result={{ tokensImported: 0, errors }} />);
    expect(html).toContain('13 accounts could not be read');
    expect(html).toContain('failure 9');
    expect(html).not.toContain('failure 10');
    // v2 slices to a cap and says nothing about the remainder, so the header
    // count and the list silently disagree.
    expect(html).toContain('and 3 more');
  });
});

describe('GenericJobResult', () => {
  test('a missing payload is stated, not rendered as an empty result', () => {
    expect(render(<GenericJobResult result={null} />)).toContain('without a result payload');
  });

  test('renders payload field names as field names', () => {
    // v2 runs them through a regex that produces "Accounts Created" — English
    // manufactured for a payload nobody has read, and untranslatable.
    const html = render(<GenericJobResult result={{ accountsCreated: 4 }} />);
    expect(html).toContain('accountsCreated');
    expect(html).not.toContain('Accounts Created');
  });

  test('a fractional stat is not rounded away to zero', () => {
    expect(render(<GenericJobResult result={{ ratio: 0.00007 }} />)).toContain('0.00007');
  });

  /**
   * SC-428. `transaction-import` lands on this renderer, and an import's
   * warnings are the only place it says why the history it just wrote is
   * short. They were in the payload and reachable only by opening the raw-JSON
   * disclosure, which is not a place a reader looks.
   */
  test('renders the run warnings rather than leaving them in the raw payload', () => {
    const html = render(
      <GenericJobResult
        result={{
          transactions: 12,
          warnings: ['binance: a run with no start date reaches 5 years back and no further'],
        }}
      />
    );
    expect(html).toContain('reaches 5 years back');
    expect(html).toContain('1 thing worth knowing');
    // Under its own heading. A warning is not a failure, and a run that
    // finished cleanly must not read as one.
    expect(html).not.toContain('error');
  });

  test('a run with only warnings is not "nothing to show"', () => {
    const html = render(
      <GenericJobResult result={{ warnings: ['bitstamp: the txid lookup capped'] }} />
    );
    expect(html).not.toContain('carried no fields we can show');
  });

  test('a clean run shows no warnings block at all', () => {
    expect(render(<GenericJobResult result={{ transactions: 3 }} />)).not.toContain(
      'worth knowing'
    );
  });
});

describe('FileImportResult', () => {
  const SUMMARY = {
    format: 'csv',
    accountId: 'acc-1',
    transactionCount: 0,
    observationCount: 2,
    holdingsCreated: ['h1'],
    holdingsTouched: [
      {
        holdingId: 'h1',
        symbol: 'BTC',
        name: 'Bitcoin',
        transactionCount: 0,
        closingBalance: '0.00007715',
      },
    ],
    warnings: [],
  };

  test('a sub-cent closing balance is not reported as zero', () => {
    // v2 renders this through `formatCurrency(balance, 'BTC')` at two decimals
    // — `BTC 0.00`, the position stated as empty on the screen that exists to
    // confirm it (SC-184).
    const html = render(<FileImportResult result={SUMMARY} jobId="job-1" />);
    expect(html).toContain('0.00007715');
  });

  test('a positions-only import is not headed "nothing was written"', () => {
    // v2 titles any run with zero transactions "No transactions were imported"
    // under a warning triangle, including one that created a holding and
    // recorded two balance anchors — which is what a positions export is.
    const html = render(<FileImportResult result={SUMMARY} jobId="job-1" />);
    expect(html).toContain('File imported');
    expect(html).not.toContain('Nothing was written');
  });

  test('a payload it cannot read is stated rather than rendered as zeroes', () => {
    expect(render(<FileImportResult result={{ nope: 1 }} jobId="job-1" />)).toContain(
      'without a result we can read'
    );
  });
});

describe('WalletImportResult', () => {
  test('a review payload with no candidate list says so instead of showing a zero', () => {
    // Falling through to the imported branch here is what told someone holding
    // 2,766 tokens that a provider had rejected their balance fetch (SC-145).
    const html = render(
      <WalletImportResult
        result={{ needsReview: true, candidateCount: 2766, chainsDetected: 4 }}
        jobId="job-1"
      />
    );
    expect(html).toContain('The detected list is not here');
    expect(html).toContain('2,766');
    expect(html).toContain('Import this wallet again');
  });

  test('a discarded import says nothing was written', () => {
    const html = render(
      <WalletImportResult result={{ needsReview: true }} jobId="job-1" reviewOutcome="discarded" />
    );
    expect(html).toContain('Nothing from this wallet was written');
  });
});
