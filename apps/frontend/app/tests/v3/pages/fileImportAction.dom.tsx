import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import i18n from 'i18next';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { FileImportPage } from '@/v3/pages/FileImportPage';
import { InvoiceUploadPage } from '@/v3/pages/InvoiceUploadPage';

const realFetch = globalThis.fetch;
let root: Root | undefined;
let client: QueryClient | undefined;
let mutations: string[] = [];

afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  document.body.innerHTML = '';
  globalThis.fetch = realFetch;
});

async function mount(node: ReactNode) {
  mutations = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const paths = new URL(String(input)).pathname.replace('/trpc/', '').split(',');
    if (init?.method === 'POST') {
      mutations.push(...paths);
      throw new Error('No mutations allowed during file selection');
    }
    const answers: Record<string, unknown> = {
      'accounts.getAll': [{ id: 'a1', name: 'Synthetic Spot', institutionId: 'i1' }],
      'institutionTypes.getAll': [],
      'accountTypes.getAll': [],
      'institutions.getAll': [{ id: 'i1', name: 'Kraken' }],
      'screenshots.capabilities': { state: 'ready', text: true, image: true, pdf: true },
    };
    return Response.json(
      paths.map((path) => {
        if (!(path in answers)) throw new Error(`Unhandled query ${path}`);
        return { result: { data: answers[path] } };
      })
    );
  }) as typeof fetch;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rpc = trpc.createClient({ links: [httpBatchLink({ url: 'http://api.test/trpc' })] });
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <trpc.Provider client={rpc} queryClient={client!}>
        <QueryClientProvider client={client!}>
          <MemoryRouter initialEntries={['/import?accountId=a1']}>{node}</MemoryRouter>
        </QueryClientProvider>
      </trpc.Provider>
    );
  });
  await act(async () => {
    for (let index = 0; index < 20; index++) await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label
  );
  if (!found) throw new Error(`Button missing: ${label}`);
  return found;
}

async function choose(id: string, name: string) {
  const input = document.getElementById(id) as HTMLInputElement;
  const transfer = new DataTransfer();
  transfer.items.add(new File(['synthetic'], name));
  input.files = transfer.files;
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
}

async function clear() {
  const remove = document.querySelector<HTMLButtonElement>('button[aria-label^="Remove "]');
  if (!remove) throw new Error('Remove file button missing');
  await act(async () => remove.click());
}

describe('rendered import action', () => {
  test('CSV imports, PDF reviews with statement intent, and clearing asks for a file', async () => {
    await mount(<FileImportPage />);
    expect(button('Choose a file').disabled).toBe(true);
    await choose('import-file', 'bank.csv');
    expect(button('Import statement').disabled).toBe(false);
    await clear();
    await choose('import-file', 'bank.pdf');
    expect(button('Upload for review').disabled).toBe(true);
    await act(async () => button(i18n.t('v3.capture.intent.statement')).click());
    expect(button('Upload for review').disabled).toBe(false);
    await act(async () => button(i18n.t('v3.capture.intent.invoice')).click());
    expect(button('Upload for review').disabled).toBe(false);
    await clear();
    expect(button('Choose a file').disabled).toBe(true);
    expect(mutations).toEqual([]);
  });

  test('invoice selection names review and never submits automatically', async () => {
    await mount(<InvoiceUploadPage />);
    expect(button('Choose a file').disabled).toBe(true);
    await choose('invoice-file', 'invoice.pdf');
    expect(button('Upload for review').disabled).toBe(false);
    await clear();
    expect(button('Choose a file').disabled).toBe(true);
    expect(mutations).toEqual([]);
  });
});
