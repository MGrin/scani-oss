import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Toaster } from '@scani/ui/ui/toaster';
import { DESKTOP_QUERY } from '@scani/ui/v3/hooks/useMediaQuery';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { trpc } from '@/lib/trpc';
import { UntrackedArrivalSheet } from '@/v3/components/review/UntrackedArrivalReview';

/**
 * "Was this the transfer to <account>?" (SC-1696), mounted against a stubbed
 * tRPC endpoint. What it pins: the sheet names the account the money arrived
 * in, what left and from where; nothing is written on open; yes and no each
 * call their own procedure with this outflow and this arrival; and a question
 * answered elsewhere closes the sheet. Runs in the DOM process
 * `packages/frontend/ui/tests/helpers/dom-specs.ts` starts; assertions read
 * strings, never nodes (see `mount-dom.ts`).
 */

const OUTFLOW = '11111111-1111-4111-8111-111111111111';
const INFLOW = '22222222-2222-4222-8222-222222222222';
const KEY = { outflowId: OUTFLOW, inflowId: INFLOW };

function question() {
  return {
    outflowId: OUTFLOW,
    inflowId: INFLOW,
    tokenSymbol: 'USD',
    quantity: '500',
    arrivedQuantity: '500',
    sourceAccountName: 'Wise Savings',
    destinationAccountName: 'IBKR Portfolio',
    sentAt: '2026-10-08T16:00:00.000Z',
    arrivedAt: '2026-10-09T23:59:59.000Z',
  };
}

let due: unknown[];
let calls: { path: string; input: unknown }[];
const realFetch = globalThis.fetch;
const realMatchMedia = globalThis.window?.matchMedia;

function respond(path: string, input: unknown): unknown {
  calls.push({ path, input });
  switch (path) {
    case 'untrackedArrivalReview.listDue':
      return due;
    case 'untrackedArrivalReview.confirm':
    case 'untrackedArrivalReview.decline':
      return { ok: true };
    default:
      return null;
  }
}

beforeEach(() => {
  calls = [];
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
          <UntrackedArrivalSheet
            question={KEY}
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

function text(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ');
}

async function click(label: string) {
  const target = [...document.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === label
  ) as HTMLElement | undefined;
  if (!target) throw new Error(`no button reading "${label}" in:\n${document.body.innerHTML}`);
  await act(async () => target.click());
  await flush();
}

const written = () =>
  calls.filter((call) => /^untrackedArrivalReview\.(confirm|decline)$/.test(call.path));

describe('the was-this-a-transfer sheet', () => {
  test('names the account it arrived in, what left and from where, and writes nothing on open', async () => {
    await mount();
    const shown = text();
    expect(shown).toContain('Was this the transfer to IBKR Portfolio?');
    expect(shown).toContain('500 USD');
    expect(shown).toContain('Wise Savings');
    expect(written()).toEqual([]);
  });

  test('yes links the two, naming this outflow and this arrival', async () => {
    await mount();
    await click('Yes, link them');
    expect(written()).toEqual([{ path: 'untrackedArrivalReview.confirm', input: KEY }]);
    expect(closed).toBe(1);
  });

  test('no keeps the answer given, and does not ask about this arrival again', async () => {
    await mount();
    expect(text()).toContain('your answer stays');
    await click('No, keep my answer');
    expect(written()).toEqual([{ path: 'untrackedArrivalReview.decline', input: KEY }]);
    expect(closed).toBe(1);
  });

  test('answered elsewhere: the sheet closes rather than asking about nothing', async () => {
    due = [];
    await mount();
    expect(closed).toBe(1);
  });
});
