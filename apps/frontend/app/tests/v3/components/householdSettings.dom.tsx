import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Toaster } from '@scani/ui/ui/toaster';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { trpc } from '@/lib/trpc';
import { HouseholdSettings } from '@/v3/components/settings/HouseholdSettings';

/**
 * The household block in Settings (SC-1647), mounted against a stubbed tRPC
 * endpoint. It pins the two things a person acts on: the invite shows the
 * link to copy and says whether it was emailed, and a Share switch sends
 * `household.share` for exactly that account. Runs in the DOM process
 * `packages/frontend/ui/tests/helpers/dom-specs.ts` starts.
 */

const ALICE = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const HOUSEHOLD = '33333333-3333-4333-8333-333333333333';
const LINK = 'http://app.test/auth?returnTo=%2Fhousehold%2Faccept%3Ftoken%3Dshh_abc';

let calls: { path: string; input: unknown }[];
let shared: string[];
const realFetch = globalThis.fetch;

function respond(path: string, input: unknown): unknown {
  calls.push({ path, input });
  switch (path) {
    case 'household.mine':
      return {
        household: { householdId: HOUSEHOLD, name: 'Home', role: 'admin', baseCurrencyId: ACCOUNT },
        members: [
          { userId: ALICE, name: 'alice', role: 'admin', joinedAt: '2026-10-01T00:00:00Z' },
        ],
        invites: [],
        sharedAccountIds: shared,
      };
    case 'accounts.getByUserIdWithSummary':
      return [{ id: ACCOUNT, name: 'Joint', institution: { name: 'Bank' } }];
    case 'users.getSupportedCurrencies':
      return [];
    case 'household.invite':
      return { url: LINK, emailed: false };
    case 'household.share':
      shared = [ACCOUNT];
      return null;
    default:
      return null;
  }
}

beforeEach(() => {
  calls = [];
  shared = [];
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
});

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
});

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const trpcClient = trpc.createClient({ links: [httpBatchLink({ url: 'http://api.test/trpc' })] });
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <trpc.Provider client={trpcClient} queryClient={client}>
        <QueryClientProvider client={client}>
          <HouseholdSettings />
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

async function type(input: Element | null, value: string) {
  if (!(input instanceof HTMLInputElement)) throw new Error('no input');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const writes = (path: string) => calls.filter((c) => c.path === path).map((c) => c.input);

describe('the household settings block', () => {
  test('an invite shows the link to copy and says it was not emailed', async () => {
    await mount();
    await type(document.querySelector('input[type="email"]'), 'bob@example.com');
    const form = document.querySelector('form[data-household="invite"]');
    if (!(form instanceof HTMLFormElement)) throw new Error('no invite form');
    await act(async () => form.requestSubmit());
    await flush();

    expect(writes('household.invite')).toEqual([{ email: 'bob@example.com' }]);
    expect(text()).toContain(LINK);
    expect(text()).toContain('Copy link');
    expect(text()).toContain('not emailed');
  });

  test('the Share switch sends household.share for that account', async () => {
    await mount();
    // The account list loads only once `mine` has answered, one round later.
    let toggle: Element | null = null;
    for (let i = 0; i < 10 && !toggle; i++) {
      await flush();
      toggle = document.querySelector(`[role="switch"][data-account="${ACCOUNT}"]`);
    }
    if (!(toggle instanceof HTMLElement))
      throw new Error(`no switch in:\n${document.body.innerHTML}`);
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    await act(async () => toggle.click());
    await flush();

    expect(writes('household.share')).toEqual([{ accountId: ACCOUNT }]);
  });
});
