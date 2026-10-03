import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Toaster } from '@scani/ui/ui/toaster';
import { DESKTOP_QUERY } from '@scani/ui/v3/hooks/useMediaQuery';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { trpc } from '@/lib/trpc';
import { UnpriceableAirdropsSheet } from '@/v3/components/review/UnpriceableAirdrops';

/**
 * The sheet that asks once whether to hide wallet tokens nothing can price
 * (SC-1469), mounted against a stubbed tRPC endpoint. What it pins: nothing is
 * written until the owner answers, the ticked ids are hidden and the unticked
 * ones are kept (so they are never asked about again), Undo restores exactly
 * the ones hidden and leaves the keep standing, and no valuation is asked to
 * change. Runs in the DOM process
 * `packages/frontend/ui/tests/helpers/dom-specs.ts` starts; assertions read
 * strings, never nodes (see `mount-dom.ts`).
 */

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';

function airdrop(holdingId: string, tokenSymbol: string) {
  return {
    holdingId,
    tokenSymbol,
    tokenName: `${tokenSymbol} token`,
    tokenTypeCode: 'crypto',
    accountName: 'MetaMask',
    balance: '1000',
    arrivedAt: '2026-09-20T00:00:00.000Z',
  };
}

let pending: unknown[];
let calls: { path: string; input: unknown }[];
const realFetch = globalThis.fetch;
const realMatchMedia = globalThis.window?.matchMedia;

/** tRPC v10's batch wire: `path1,path2?batch=1`, inputs keyed by position. */
function respond(path: string, input: unknown): unknown {
  calls.push({ path, input });
  switch (path) {
    case 'holdings.unpriceableAirdrops':
      return pending;
    case 'holdings.bulkDelete': {
      const ids = (input as { ids: string[] }).ids;
      return {
        success: true,
        deleted: ids.length,
        failed: 0,
        total: ids.length,
        deletedIds: ids,
        failedIds: [],
      };
    }
    case 'holdings.keepUnpriceableAirdrops':
      return { keptIds: (input as { ids: string[] }).ids };
    case 'holdings.restore':
      return { id: (input as { id: string }).id };
    default:
      return null;
  }
}

beforeEach(() => {
  calls = [];
  pending = [airdrop(FIRST, 'DUST'), airdrop(SECOND, 'CLAIM'), airdrop(THIRD, 'DROP')];
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
          <UnpriceableAirdropsSheet
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

/** The primary action's label, read off the button rather than assumed. */
function primary(): string {
  const buttons = [...document.querySelectorAll('button')].map((el) => el.textContent?.trim());
  const label = buttons.find((name) => name && /^(Hide|Keep) /.test(name));
  if (!label) throw new Error(`no primary action in:\n${html()}`);
  return label;
}

async function click(label: string) {
  const target = [...document.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === label
  ) as HTMLElement | undefined;
  if (!target) throw new Error(`no button reading "${label}" in:\n${html()}`);
  await act(async () => target.click());
  await flush();
}

async function untick(holdingId: string) {
  const box = document.getElementById(`unpriceable-${holdingId}`);
  if (!box) throw new Error(`no checkbox for ${holdingId} in:\n${html()}`);
  await act(async () => box.click());
  await flush();
}

const writes = (path: string) =>
  calls.filter((call) => call.path === path).map((call) => call.input);

/** Every procedure the sheet called, so a valuation write cannot slip in. */
const paths = () => [...new Set(calls.map((call) => call.path))].sort();

describe('the unpriceable-airdrops sheet', () => {
  test('lists each token with its wallet and quantity, and writes nothing on open', async () => {
    await mount();
    const shown = text();
    expect(shown).toContain('Tokens nothing can price');
    expect(shown).toContain('DUST');
    expect(shown).toContain('CLAIM');
    expect(shown).toContain('MetaMask');
    expect(shown).toContain('1,000');
    expect(shown).not.toMatch(/scam|spam/i);
    expect(writes('holdings.bulkDelete')).toEqual([]);
    expect(writes('holdings.keepUnpriceableAirdrops')).toEqual([]);
  });

  test('the button names what it hides: Hide all when every row is ticked, Hide N otherwise', async () => {
    await mount();
    expect(primary()).toBe('Hide all');
    await untick(THIRD);
    expect(primary()).toBe('Hide 2');
    await untick(SECOND);
    expect(primary()).toBe('Hide 1');
  });

  test('Hide all hides exactly the listed ids, then Undo restores each', async () => {
    await mount();
    await click('Hide all');
    expect(writes('holdings.bulkDelete')).toEqual([{ ids: [FIRST, SECOND, THIRD] }]);
    expect(writes('holdings.keepUnpriceableAirdrops')).toEqual([]);
    expect(text()).toContain('3 tokens hidden');
    expect(closed).toBeGreaterThan(0);

    await click('Undo');
    expect(writes('holdings.restore')).toEqual([{ id: FIRST }, { id: SECOND }, { id: THIRD }]);
    // Hiding and restoring are the only writes: these rows already count for
    // zero, so nothing that values the portfolio is touched.
    expect(paths()).toEqual([
      'holdings.bulkDelete',
      'holdings.restore',
      'holdings.unpriceableAirdrops',
    ]);
  });

  test('the ticked are hidden, the unticked are kept, and Undo reverts only the hide', async () => {
    await mount();
    await untick(SECOND);
    await click('Hide 2');
    expect(writes('holdings.bulkDelete')).toEqual([{ ids: [FIRST, THIRD] }]);
    expect(writes('holdings.keepUnpriceableAirdrops')).toEqual([{ ids: [SECOND] }]);
    expect(closed).toBeGreaterThan(0);

    // A human was shown SECOND and kept it; undoing the hide does not unsay that.
    await click('Undo');
    expect(writes('holdings.restore')).toEqual([{ id: FIRST }, { id: THIRD }]);
    expect(writes('holdings.keepUnpriceableAirdrops')).toHaveLength(1);
  });

  test('every row unticked reads Keep all and only keeps', async () => {
    await mount();
    await untick(FIRST);
    await untick(SECOND);
    await untick(THIRD);
    expect(primary()).toBe('Keep all');
    await click('Keep all');
    expect(writes('holdings.keepUnpriceableAirdrops')).toEqual([{ ids: [FIRST, SECOND, THIRD] }]);
    expect(writes('holdings.bulkDelete')).toEqual([]);
    expect(closed).toBeGreaterThan(0);
  });

  test('Cancel writes nothing', async () => {
    await mount();
    await click('Cancel');
    expect(writes('holdings.bulkDelete')).toEqual([]);
    expect(writes('holdings.keepUnpriceableAirdrops')).toEqual([]);
    expect(closed).toBeGreaterThan(0);
  });
});
