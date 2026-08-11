import { describe, expect, test } from 'bun:test';
import type { ReactElement } from 'react';
import { ExchangeImportResult } from '../../../src/v2/components/jobs/ExchangeImportResult';
import { FileImportResult } from '../../../src/v2/components/jobs/FileImportResult';
import { GenericJobResult } from '../../../src/v2/components/jobs/GenericJobResult';
import { ManualHoldingsCreateResult } from '../../../src/v2/components/jobs/ManualHoldingsCreateResult';
import { ScreenshotParseResult } from '../../../src/v2/components/jobs/ScreenshotParseResult';
import { WalletImportResult } from '../../../src/v2/components/jobs/WalletImportResult';
import { resolveReviewRenderer } from '../../../src/v2/lib/review-registry';

const BASE_PROPS = { result: {}, jobId: 'j1', actionTakenAt: null };

describe('resolveReviewRenderer', () => {
  test('resolves every kind that previously had a switch arm', () => {
    for (const kind of [
      'wallet-import',
      'exchange-import',
      'screenshot-parse',
      'file-import',
      'manual-holdings-create',
    ]) {
      expect(resolveReviewRenderer(kind).kind).toBe(kind);
    }
  });

  // Guards against two entries' render bodies being swapped while their
  // `kind` labels stay correct — the `.kind` check above can't catch that.
  test.each([
    ['wallet-import', WalletImportResult],
    ['exchange-import', ExchangeImportResult],
    ['screenshot-parse', ScreenshotParseResult],
    ['file-import', FileImportResult],
    ['manual-holdings-create', ManualHoldingsCreateResult],
  ] as const)('renders the component wired to kind %s', (kind, component) => {
    const renderer = resolveReviewRenderer(kind);
    const element = renderer.render(BASE_PROPS) as ReactElement;
    expect(element.type).toBe(component);
  });

  test('falls back for an unknown kind instead of throwing', () => {
    // A job type the frontend has never heard of must render a generic
    // summary, not blank the page.
    const renderer = resolveReviewRenderer('some-future-job');
    expect(renderer.kind).toBe('__fallback__');
    expect(typeof renderer.render).toBe('function');
    const element = renderer.render(BASE_PROPS) as ReactElement;
    expect(element.type).toBe(GenericJobResult);
  });

  test('falls back for an empty kind', () => {
    expect(resolveReviewRenderer('').kind).toBe('__fallback__');
  });
});
