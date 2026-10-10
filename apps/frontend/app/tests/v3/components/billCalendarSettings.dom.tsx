import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Toaster } from '@scani/ui/ui/toaster';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import i18n from 'i18next';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { trpc } from '@/lib/trpc';
import { BillCalendarSettings } from '@/v3/components/settings/BillCalendarSettings';

/**
 * The bills calendar block in Settings (SC-1654), against a stubbed tRPC
 * endpoint. It pins what the operator asked for: off by default, the privacy
 * sentence always in view, the URL shown once, and turning off reaching the
 * server. Runs in the DOM process `dom-specs.ts` starts.
 */

const URL_ONCE = 'http://api.test/calendar/scani_cal_abc.ics';
const T = i18n.t.bind(i18n);

let calls: { path: string; input: unknown }[];
let enabled: boolean;
const realFetch = globalThis.fetch;

function respond(path: string, input: unknown): unknown {
  calls.push({ path, input });
  switch (path) {
    case 'billCalendar.status':
      return { enabled, createdAt: enabled ? '2026-10-01T00:00:00.000Z' : null };
    case 'billCalendar.enable':
      enabled = true;
      return { url: URL_ONCE };
    case 'billCalendar.disable':
      enabled = false;
      return { enabled: false };
    default:
      return null;
  }
}

beforeEach(() => {
  calls = [];
  enabled = false;
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
          <BillCalendarSettings />
          <Toaster />
        </QueryClientProvider>
      </trpc.Provider>
    );
  });
  await flush();
}

const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ');
const writes = (path: string) => calls.filter((c) => c.path === path);

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === label
  );
  if (!found) throw new Error(`no "${label}" button in:\n${document.body.innerHTML}`);
  return found;
}

describe('the bills calendar block', () => {
  test('off by default, and it says plainly what the link exposes', async () => {
    await mount();
    expect(text()).toContain(T('v3.settings.billCalendar.warning'));
    expect(button(T('v3.settings.billCalendar.enable'))).toBeTruthy();
    expect(text()).not.toContain('scani_cal_');
  });

  test('turning it on shows the link once, to copy', async () => {
    await mount();
    await act(async () => button(T('v3.settings.billCalendar.enable')).click());
    await flush();
    expect(writes('billCalendar.enable')).toHaveLength(1);
    expect(text()).toContain(URL_ONCE);
    expect(text()).toContain(T('v3.settings.billCalendar.copyOnce'));
    expect(button(T('v3.settings.billCalendar.copy'))).toBeTruthy();
    expect(text()).toContain(T('v3.settings.billCalendar.warning'));
  });

  test('“Add to calendar” opens the webcal form of the same link, for one-tap subscribe', async () => {
    await mount();
    await act(async () => button(T('v3.settings.billCalendar.enable')).click());
    await flush();
    const add = [...document.querySelectorAll('a')].find(
      (el) => el.textContent?.trim() === T('v3.settings.billCalendar.addToCalendar')
    );
    expect(add?.getAttribute('href')).toBe('webcal://api.test/calendar/scani_cal_abc.ics');
  });

  test('when on, it offers a new link and turning off, and never the old URL', async () => {
    enabled = true;
    await mount();
    expect(button(T('v3.settings.billCalendar.rotate'))).toBeTruthy();
    expect(button(T('v3.settings.billCalendar.disable'))).toBeTruthy();
    expect(text()).not.toContain('scani_cal_');
  });

  test('turning off, once confirmed, reaches the server', async () => {
    enabled = true;
    await mount();
    await act(async () => button(T('v3.settings.billCalendar.disable')).click());
    await flush();
    await act(async () => button(T('v3.settings.billCalendar.disableConfirm')).click());
    await flush();
    expect(writes('billCalendar.disable')).toHaveLength(1);
    expect(button(T('v3.settings.billCalendar.enable'))).toBeTruthy();
  });
});
