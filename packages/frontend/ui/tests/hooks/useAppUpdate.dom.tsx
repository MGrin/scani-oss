import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  setUpdateOfferReporter,
  type UpdateOffer,
  useAppUpdate,
} from '../../src/hooks/useAppUpdate';

/**
 * The service-worker route raised the banner without asking which build the
 * host serves (SC-1562). On an installed iPhone app the banner came straight
 * back after Update, 3 to 7 times in a row, while the page already ran the
 * served build. Runs in the DOM process `../helpers/dom-specs.ts` starts.
 */

const RUNNING = '7-running';
const NEWER = '8-newer';

type Listener = (event: unknown) => void;

let served: string;
let offers: UpdateOffer[] = [];
let root: Root | null = null;
let container: HTMLDivElement | null = null;
let workerStateListeners: Listener[] = [];
let updateFoundListeners: Listener[] = [];
const realFetch = globalThis.fetch;

function installWorker() {
  workerStateListeners = [];
  updateFoundListeners = [];
  const installing = {
    state: 'installed',
    addEventListener: (type: string, listener: Listener) => {
      if (type === 'statechange') workerStateListeners.push(listener);
    },
  };
  const registration = {
    waiting: {},
    installing,
    active: null,
    addEventListener: (type: string, listener: Listener) => {
      if (type === 'updatefound') updateFoundListeners.push(listener);
    },
  };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      ready: Promise.resolve(registration),
      controller: {},
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
}

function Probe(): ReactNode {
  return <span>{String(useAppUpdate().updateAvailable)}</span>;
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const target = container;
  await act(async () => {
    root = createRoot(target);
    root.render(<Probe />);
  });
  await settle();
  return target.textContent ?? '';
}

beforeEach(() => {
  localStorage.clear();
  offers = [];
  setUpdateOfferReporter((offer) => offers.push(offer));
  (globalThis as { __SCANI_BUILD_VERSION__?: string }).__SCANI_BUILD_VERSION__ = RUNNING;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ version: served }), {
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  installWorker();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  globalThis.fetch = realFetch;
  setUpdateOfferReporter(null);
  delete (globalThis as { __SCANI_BUILD_VERSION__?: string }).__SCANI_BUILD_VERSION__;
});

describe('the service-worker route confirms with the host before offering', () => {
  test('a waiting worker while the host serves the running build raises no banner', async () => {
    served = RUNNING;
    expect(await mount()).toBe('false');
    expect(offers).toEqual([]);
  });

  test('a waiting worker while the host serves a newer build raises the banner', async () => {
    served = NEWER;
    expect(await mount()).toBe('true');
    expect(offers).toEqual([{ route: 'sw-waiting', served: NEWER, bundle: RUNNING }]);
  });

  test('a second worker signal for a newer build raises the banner once', async () => {
    served = NEWER;
    expect(await mount()).toBe('true');
    for (const listener of updateFoundListeners) listener({});
    for (const listener of workerStateListeners) listener({});
    await settle();
    expect(container?.textContent).toBe('true');
    expect(offers.map((offer) => offer.route)).toEqual(['sw-waiting']);
  });

  test('a second worker signal for the same build is the same banner, not another', async () => {
    served = RUNNING;
    expect(await mount()).toBe('false');
    for (const listener of updateFoundListeners) listener({});
    for (const listener of workerStateListeners) listener({});
    await settle();
    expect(container?.textContent).toBe('false');
    expect(offers).toEqual([]);
  });
});
