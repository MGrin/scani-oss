import { describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { trpc } from '../../../src/lib/trpc';
import { WalletImportResult } from '../../../src/v2/components/jobs/WalletImportResult';

/**
 * Rendered statically, like every other job-result surface test. The tRPC
 * provider is here only because the review card declares mutation hooks at
 * the top of its body; nothing in these assertions fetches, and no request
 * is ever made from a static render. That keeps these tests about the copy
 * the user reads rather than about a mocked client.
 */
function render(node: ReactNode): string {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: 'http://localhost/trpc' })],
  });
  return renderToStaticMarkup(
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <StaticRouter location="/jobs/job-1">{node}</StaticRouter>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

describe('WalletImportResult — a result it cannot show is not a result of zero', () => {
  // SC-145: the 32 KB job-result cap turned `chains` from an array into a
  // marker object, the `Array.isArray` guard failed, and a wallet holding
  // 2,766 tokens fell through to the legacy branch — which reported 0
  // holdings AND asserted a provider rejection that never happened.
  const TRUNCATED = {
    needsReview: true,
    chains: { _truncated: true, originalBytes: 808577 },
    errors: [],
    candidateCount: 2766,
    chainsDetected: 1,
  };

  test('does not fall through to the imported-holdings branch', () => {
    const html = render(<WalletImportResult result={TRUNCATED} jobId="job-1" />);
    expect(html).not.toContain('Imported holdings');
    expect(html).toContain('Detected holdings are unavailable');
  });

  test('never invents a provider rejection', () => {
    const html = render(<WalletImportResult result={TRUNCATED} jobId="job-1" />);
    expect(html).not.toContain('provider API rejected');
  });

  test('says how many tokens were actually found rather than showing a zero', () => {
    const html = render(<WalletImportResult result={TRUNCATED} jobId="job-1" />);
    expect(html).toContain('2766');
    expect(html).not.toContain('0 holdings');
  });

  // The same branch after the truncator fix: an omitted field is absent
  // rather than retyped, and absence must land in the same honest state.
  test('handles an omitted chains field the same way as a retyped one', () => {
    const html = render(
      <WalletImportResult
        result={{
          needsReview: true,
          _truncation: { omittedFields: ['chains'], originalBytes: 808577 },
          candidateCount: 2766,
          chainsDetected: 1,
          errors: [],
        }}
        jobId="job-1"
      />
    );
    expect(html).toContain('Detected holdings are unavailable');
    expect(html).not.toContain('Imported holdings');
  });
});

describe('WalletImportResult — a failed fetch is not an empty wallet', () => {
  // SC-139: chain detected, Etherscan refused the key, zero candidates.
  const FAILED = {
    needsReview: true,
    chains: [],
    errors: [
      {
        chainId: 'linea',
        chainName: 'Linea',
        error: 'Etherscan rate limit / auth: Missing/Invalid API Key',
      },
    ],
    chainsDetected: 1,
    candidateCount: 0,
  };

  test('does not claim the wallet holds nothing', () => {
    const html = render(<WalletImportResult result={FAILED} jobId="job-1" />);
    expect(html).not.toContain('We found 0 tokens');
    expect(html).toContain('could not be read');
  });

  test('surfaces the provider error the job result recorded', () => {
    const html = render(<WalletImportResult result={FAILED} jobId="job-1" />);
    expect(html).toContain('Missing/Invalid API Key');
    expect(html).toContain('Linea');
  });

  test('reports the chain it was detected on, not the chains it managed to read', () => {
    const html = render(<WalletImportResult result={FAILED} jobId="job-1" />);
    expect(html).not.toContain('0 chains');
  });

  test('a clean empty wallet still says so plainly', () => {
    const html = render(
      <WalletImportResult
        result={{ needsReview: true, chains: [], errors: [], chainsDetected: 1, candidateCount: 0 }}
        jobId="job-1"
      />
    );
    expect(html).toContain('Nothing to review');
    expect(html).not.toContain('could not be read');
  });
});

describe('WalletImportResult — discarded reviews', () => {
  test('a discarded import is not rendered as an imported one', () => {
    const html = render(
      <WalletImportResult
        result={{ needsReview: true, chains: [], errors: [], chainsDetected: 1 }}
        jobId="job-1"
        actionTakenAt="2026-08-14T12:00:00.000Z"
        reviewOutcome="discarded"
      />
    );
    expect(html).toContain('Discarded');
    expect(html).not.toContain('already been confirmed');
  });
});
