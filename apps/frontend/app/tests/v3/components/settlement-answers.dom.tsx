import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Toaster } from '@scani/ui/ui/toaster';
import { DESKTOP_QUERY } from '@scani/ui/v3/hooks/useMediaQuery';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { trpc } from '@/lib/trpc';
import { SettlementAnswersSheet } from '@/v3/components/review/SettlementAnswers';

/**
 * The sheet for one holding's answers imported trades now explain (SC-1453),
 * mounted against a stubbed tRPC endpoint. What it pins is who the owner has
 * to be before anything is written: Retire and Keep call the server once per
 * answer, an answer that changed another holding asks a second time before
 * Retire sends `confirmOtherHolding`, and the toast's Undo puts back exactly
 * the answers that were retired. Runs in the DOM process
 * `packages/frontend/ui/tests/helpers/dom-specs.ts` starts; assertions read
 * strings, never nodes (see `mount-dom.ts`).
 */

const HOLDING = '22222222-2222-4222-8222-222222222222';
const FULL = '11111111-1111-4111-8111-111111111111';
const PARTIAL = '33333333-3333-4333-8333-333333333333';

function answer(observationId: string, over: Record<string, unknown> = {}) {
  return {
    observationId,
    answeredAt: '2026-09-01T00:00:00.000Z',
    from: '2026-06-01T00:00:00.000Z',
    to: '2026-06-26T00:00:00.000Z',
    amount: '-1000',
    explained: 'full',
    remainder: '0',
    movesAnotherHolding: false,
    ...over,
  };
}

let pending: unknown[];
let calls: { path: string; input: unknown }[];
const realFetch = globalThis.fetch;
const realMatchMedia = globalThis.window?.matchMedia;

function holding(answers: unknown[]) {
  return [
    {
      holdingId: HOLDING,
      tokenSymbol: 'USD',
      tokenTypeCode: 'fiat',
      accountName: 'Broker',
      answers,
    },
  ];
}

/** tRPC v10's batch wire: `path1,path2?batch=1`, inputs keyed by position. */
function respond(path: string, input: unknown): unknown {
  calls.push({ path, input });
  switch (path) {
    case 'settlementAnswers.listPending':
      return pending;
    case 'settlementAnswers.retire': {
      const id = (input as { observationId: string }).observationId;
      return { id: `retired-${id}`, explained: 'full', remainder: '0' };
    }
    case 'settlementAnswers.keep':
      return { kept: true };
    case 'settlementAnswers.undoRetire':
      return { rows: 1, observation: 'restamped' };
    default:
      return null;
  }
}

beforeEach(() => {
  calls = [];
  pending = holding([
    answer(FULL),
    answer(PARTIAL, {
      from: '2026-06-26T00:00:00.000Z',
      to: '2026-07-19T00:00:00.000Z',
      amount: '-750',
      explained: 'partial',
      remainder: '-440',
    }),
  ]);
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const paths = decodeURIComponent(url.pathname.replace(/^\/trpc\//, '')).split(',');
    const inputs = (
      init?.body ? JSON.parse(String(init.body)) : JSON.parse(url.searchParams.get('input') ?? '{}')
    ) as Record<string, unknown>;
    return Response.json(
      paths.map((path, index) => ({ result: { data: respond(path, inputs[String(index)]) } }))
    );
  }) as typeof fetch;
  window.matchMedia = ((query: string) => ({
    matches: query === DESKTOP_QUERY,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

let root: Root | null = null;
let closed = 0;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  closed = 0;
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
  if (realMatchMedia) window.matchMedia = realMatchMedia;
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const trpcClient = trpc.createClient({
    links: [httpBatchLink({ url: 'http://api.test/trpc' })],
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <trpc.Provider client={trpcClient} queryClient={client}>
        <QueryClientProvider client={client}>
          <SettlementAnswersSheet
            holdingId={HOLDING}
            onClose={() => {
              closed += 1;
            }}
          />
          <Toaster />
        </QueryClientProvider>
      </trpc.Provider>
    );
  });
  await flush();
}

function html(): string {
  return document.body.innerHTML;
}

function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ');
}

async function click(label: string) {
  const target = [...document.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === label
  ) as HTMLElement | undefined;
  if (!target) throw new Error(`no button reading "${label}" in:\n${html()}`);
  await act(async () => target.click());
  await flush();
}

const writes = (path: string) =>
  calls.filter((call) => call.path === path).map((call) => call.input);

describe('the settled-answers sheet', () => {
  test('lists each answer with its interval, its amount and how much the trades explain', async () => {
    await mount();
    const shown = text();
    expect(shown).toContain('Explanations on Broker · USD');
    expect(shown).toContain('Explained by imported trades');
    expect(shown).toContain('310.00 of 750.00 explained by imported trades');
    expect(shown).toContain('1,000.00');
    expect(writes('settlementAnswers.retire')).toEqual([]);
  });

  test('Retire retires every answer once, then Undo puts back exactly those', async () => {
    await mount();
    await click('Retire');
    expect(writes('settlementAnswers.retire')).toEqual([
      { observationId: FULL },
      { observationId: PARTIAL },
    ]);
    expect(text()).toContain('2 explanations retired');
    expect(closed).toBeGreaterThan(0);

    await click('Undo');
    expect(writes('settlementAnswers.undoRetire')).toEqual([
      { retiredId: `retired-${FULL}` },
      { retiredId: `retired-${PARTIAL}` },
    ]);
  });

  test('an answer that changed another holding asks again before anything is retired', async () => {
    pending = holding([answer(FULL, { movesAnotherHolding: true })]);
    await mount();
    expect(text()).toContain('This explanation also changed another holding');

    await click('Retire');
    expect(writes('settlementAnswers.retire')).toEqual([]);
    expect(text()).toContain(
      'Retiring also removes what these explanations recorded on another holding.'
    );

    await click('Yes, retire them');
    expect(writes('settlementAnswers.retire')).toEqual([
      { observationId: FULL, confirmOtherHolding: true },
    ]);
  });

  test('Keep keeps every answer and retires nothing', async () => {
    await mount();
    await click('Keep');
    expect(writes('settlementAnswers.keep')).toEqual([
      { observationId: FULL },
      { observationId: PARTIAL },
    ]);
    expect(writes('settlementAnswers.retire')).toEqual([]);
    expect(closed).toBeGreaterThan(0);
  });
});
