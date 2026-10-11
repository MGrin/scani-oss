import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScaniBrand } from '@/v3/layouts/ScaniBrand';

/**
 * SC-1588. After a backend-only release the app's own output does not change,
 * so `/version.json` keeps its `version` and no update banner appears, by
 * design (SC-1562). The brand sheet read the release from the `scani-build`
 * meta tag, written once per page load, so an app opened before the release
 * kept naming the old one. It now asks `/version.json` when the sheet opens.
 * Runs in the DOM process `packages/frontend/ui/tests/helpers/dom-specs.ts`
 * starts.
 */

const LOADED_COMMIT = 'a'.repeat(40);
const SERVED_COMMIT = 'b'.repeat(40);

function coreBuild(productVersion: string) {
  return {
    productVersion,
    releaseCommit: 'c'.repeat(40),
    coreFingerprint: 'd'.repeat(64),
    pendingChangeCount: 0,
  };
}

const realFetch = globalThis.fetch;
let requests: Array<{ url: string; cache: RequestCache | undefined }> = [];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function serve(body: unknown, status = 200) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), cache: init?.cache });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function openSheet(): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const target = container;
  await act(async () => {
    root = createRoot(target);
    root.render(<ScaniBrand />);
  });
  const button = target.querySelector('button');
  if (!button) throw new Error('no brand button');
  expect(button.textContent).toBe('v0.52.2');
  await act(async () => button.click());
  await settle();
  return document.body.textContent ?? '';
}

beforeEach(() => {
  requests = [];
  const meta = document.createElement('meta');
  meta.name = 'scani-build';
  meta.content = JSON.stringify({ commit: LOADED_COMMIT, coreBuild: coreBuild('0.52.2') });
  document.head.appendChild(meta);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.head.querySelector('meta[name="scani-build"]')?.remove();
  globalThis.fetch = realFetch;
});

describe('the brand sheet names the release the host serves', () => {
  test('a release that changed no app code shows once the sheet opens, without a reload', async () => {
    serve({
      version: 'e0280848aded0505',
      productVersion: '0.53.0',
      coreBuild: { ...coreBuild('0.53.0'), commit: SERVED_COMMIT },
      commit: SERVED_COMMIT,
    });
    const text = await openSheet();
    expect(requests).toEqual([{ url: '/version.json', cache: 'no-store' }]);
    expect(text).toContain('v0.53.0');
    expect(text).toContain(SERVED_COMMIT);
    expect(text).not.toContain('v0.52.2');
  });

  test('a host that cannot be read leaves the page-load release', async () => {
    serve({}, 503);
    const text = await openSheet();
    expect(text).toContain('v0.52.2');
    expect(text).toContain(LOADED_COMMIT);
  });
});
