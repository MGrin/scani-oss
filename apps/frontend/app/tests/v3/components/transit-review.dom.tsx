import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Toaster } from '@scani/ui/ui/toaster';
import { DESKTOP_QUERY } from '@scani/ui/v3/hooks/useMediaQuery';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { trpc } from '@/lib/trpc';
import { TransitReviewSheet } from '@/v3/components/review/TransitReview';

/**
 * The day-7 question about a transfer still in transit (SC-1675, rulings
 * #23848), mounted against a stubbed tRPC endpoint. What it pins: the sheet
 * says what left, from where and to where; nothing is written on open; each of
 * the four answers calls its own procedure with this outflow and destination
 * (SC-1684); an arrival or a
 * refund can only be one the server offered; and a shortfall under the amount
 * sent is said aloud as a fee before it is booked. Runs in the DOM process
 * `packages/frontend/ui/tests/helpers/dom-specs.ts` starts; assertions read
 * strings, never nodes (see `mount-dom.ts`).
 */

const OUTFLOW = '11111111-1111-4111-8111-111111111111';
const INFLOW = '22222222-2222-4222-8222-222222222222';
const REFUND = '33333333-3333-4333-8333-333333333333';
const DESTINATION = '55555555-5555-4555-8555-555555555555';
const KEY = { outflowId: OUTFLOW, destinationHoldingId: DESTINATION };

function question() {
  return {
    outflowId: OUTFLOW,
    sourceHoldingId: '44444444-4444-4444-8444-444444444444',
    destinationHoldingId: DESTINATION,
    tokenId: '66666666-6666-4666-8666-666666666666',
    tokenSymbol: 'USDC',
    sourceAccountName: 'Wise',
    destinationAccountName: 'Kraken',
    sentAt: '2026-10-01T09:00:00.000Z',
    quantity: '1500',
    dueAt: '2026-10-08T09:00:00.000Z',
  };
}

function candidate(id: string, quantity: string, occurredAt: string) {
  return { id, quantity, occurredAt, source: 'kraken', counterparty: null, description: null };
}

let due: unknown[];
let arrivals: unknown[];
let refunds: unknown[];
let calls: { path: string; input: unknown }[];
const realFetch = globalThis.fetch;
const realMatchMedia = globalThis.window?.matchMedia;

function respond(path: string, input: unknown): unknown {
  calls.push({ path, input });
  switch (path) {
    case 'transitReview.listDue':
      return due;
    case 'transitReview.candidates':
      return { arrivals, refunds };
    case 'transitReview.arrived':
    case 'transitReview.lost':
    case 'transitReview.cameBack':
    case 'transitReview.stillWaiting':
      return { ok: true };
    default:
      return null;
  }
}

beforeEach(() => {
  calls = [];
  arrivals = [candidate(INFLOW, '1485', '2026-10-03T10:00:00.000Z')];
  refunds = [candidate(REFUND, '1500', '2026-10-04T10:00:00.000Z')];
  due = [question()];
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
          <TransitReviewSheet
            transit={KEY}
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

/** The answers written, by procedure, so a write cannot slip in unseen. */
const written = () =>
  calls.filter((call) => /^transitReview\.(arrived|lost|cameBack|stillWaiting)$/.test(call.path));

async function choose(id: string) {
  const option = document.getElementById(id);
  if (!option) throw new Error(`no option ${id} in:\n${html()}`);
  await act(async () => option.click());
  await flush();
}

describe('the transfer-not-arrived sheet', () => {
  test('says what left, from where and to where, and writes nothing on open', async () => {
    await mount();
    const shown = text();
    expect(shown).toContain('Transfer not arrived');
    expect(shown).toContain('1,500 USDC');
    expect(shown).toContain('Wise');
    expect(shown).toContain('Kraken');
    expect(written()).toEqual([]);
    expect(calls.find((call) => call.path === 'transitReview.candidates')?.input).toEqual(KEY);
  });

  test("asks about this destination's part of a split, not another's", async () => {
    due = [
      {
        ...question(),
        destinationHoldingId: '77777777-7777-4777-8777-777777777777',
        destinationAccountName: 'Bybit',
        quantity: '300',
      },
      question(),
    ];
    await mount();
    const shown = text();
    expect(shown).toContain('1,500 USDC');
    expect(shown).not.toContain('Bybit');
  });

  test('it arrived: pairs with the offered inflow, and names the shortfall as a fee first', async () => {
    await mount();
    await choose(`transit-arrival-${INFLOW}`);
    expect(text()).toContain('15 USDC is booked as a fee');
    await click('Save');
    expect(written()).toEqual([
      { path: 'transitReview.arrived', input: { ...KEY, inflowId: INFLOW } },
    ]);
    expect(closed).toBe(1);
  });

  test('it came back: pairs with the offered refund', async () => {
    await mount();
    await choose(`transit-refund-${REFUND}`);
    await click('Save');
    expect(written()).toEqual([
      { path: 'transitReview.cameBack', input: { ...KEY, refundId: REFUND } },
    ]);
  });

  test('it was lost: a fee or money that left your control, as chosen', async () => {
    await mount();
    await choose('transit-lost-left_control');
    await click('Save');
    expect(written()).toEqual([
      { path: 'transitReview.lost', input: { ...KEY, decision: 'left_control' } },
    ]);
  });

  test('still waiting asks again in 7 days and keeps the money counted', async () => {
    await mount();
    await choose('transit-waiting');
    expect(text()).toContain('asks again in 7 days');
    await click('Save');
    expect(written()).toEqual([{ path: 'transitReview.stillWaiting', input: KEY }]);
  });

  test('nothing to pick means the arrival and refund answers are not offered', async () => {
    arrivals = [];
    refunds = [];
    await mount();
    expect(document.getElementById(`transit-arrival-${INFLOW}`)).toBeNull();
    expect(document.getElementById(`transit-refund-${REFUND}`)).toBeNull();
    expect(text()).toContain('No transaction on Kraken matches yet');
  });

  test('answered elsewhere: the sheet closes rather than asking about nothing', async () => {
    due = [];
    await mount();
    expect(closed).toBe(1);
  });
});
