import { afterEach, describe, expect, jest, mock, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

/**
 * SC-1772: "Can't reach Scani" asked again only on mount and when the device
 * came back online. A server outage never changes `navigator.onLine`, so after
 * a short one the screen stayed up with the server healthy, until a tap.
 */
const { ServerUnreachable } = await import('@/components/ServerUnreachable');

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

async function mount(onRetry: () => Promise<void>) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <ServerUnreachable email="reader@example.com" onRetry={onRetry} />
      </MemoryRouter>
    );
  });
  return async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}

const advance = (ms: number) => act(async () => jest.advanceTimersByTime(ms));

afterEach(() => {
  jest.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });
});

describe('ServerUnreachable while the server stays down (SC-1772)', () => {
  test('asks again by itself every 10 s', async () => {
    jest.useFakeTimers();
    const onRetry = mock(async () => {});
    const unmount = await mount(onRetry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    // One tick per step: a single 30 s jump fires every tick before the first
    // ask's promise settles, which real timers never do.
    for (let tick = 0; tick < 3; tick += 1) await advance(10_000);
    expect(onRetry).toHaveBeenCalledTimes(4);
    await unmount();
  });

  test('asks at once when the app comes back to the foreground', async () => {
    jest.useFakeTimers();
    const onRetry = mock(async () => {});
    const unmount = await mount(onRetry);
    await act(async () => setVisibility('hidden'));
    await advance(30_000);
    expect(onRetry).toHaveBeenCalledTimes(1);
    await act(async () => setVisibility('visible'));
    expect(onRetry).toHaveBeenCalledTimes(2);
    await unmount();
  });

  test('control: offline, it does not ask at all', async () => {
    jest.useFakeTimers();
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    const onRetry = mock(async () => {});
    const unmount = await mount(onRetry);
    await advance(30_000);
    expect(onRetry).toHaveBeenCalledTimes(0);
    await unmount();
  });

  test('control: an ask still in flight is not stacked on', async () => {
    jest.useFakeTimers();
    const onRetry = mock(() => new Promise<void>(() => {}));
    const unmount = await mount(onRetry);
    await advance(30_000);
    expect(onRetry).toHaveBeenCalledTimes(1);
    await unmount();
  });
});
