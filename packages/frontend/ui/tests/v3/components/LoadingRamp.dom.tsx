import { afterEach, describe, expect, test } from 'bun:test';
import { LoadingRamp } from '@scani/ui/v3/components/feedback/LoadingRamp';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * A stalled load on a device with no network said "Still waiting on the
 * server", which sends the reader to blame Scani (SC-1530). Offline is a
 * different sentence.
 */

const OFFLINE = "You're offline.";
const WAITING = 'Still waiting on the server.';

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
}

async function stalledText(): Promise<string> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(<LoadingRamp phase="stalled" skeleton={null} label="holdings" />)
  );
  const text = host.textContent ?? '';
  await act(async () => root.unmount());
  host.remove();
  return text;
}

afterEach(() => setOnline(true));

describe('LoadingRamp when stalled (SC-1530)', () => {
  test('says the device is offline when it is', async () => {
    setOnline(false);
    const text = await stalledText();
    expect(text.includes(OFFLINE)).toBe(true);
    expect(text.includes(WAITING)).toBe(false);
  });

  test('keeps the server line when the device is online', async () => {
    setOnline(true);
    const text = await stalledText();
    expect(text.includes(WAITING)).toBe(true);
    expect(text.includes(OFFLINE)).toBe(false);
  });
});
