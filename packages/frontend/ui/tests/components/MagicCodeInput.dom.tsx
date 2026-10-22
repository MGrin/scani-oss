import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MagicCodeInput } from '../../src/components/MagicCodeInput';

/**
 * SC-1750: a sign-in on an installed iPhone app succeeded, and a tap on Verify
 * 0.3 s later sent the same code again. The server refused the spent code and
 * the rejection escaped as an unhandled `Error: Invalid OTP` in Sentry. Runs in
 * the DOM process `../helpers/dom-specs.ts` starts.
 */

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason);
};

beforeEach(() => {
  unhandled = [];
  process.on('unhandledRejection', onUnhandled);
});

afterEach(async () => {
  process.off('unhandledRejection', onUnhandled);
  const mounted = root;
  if (mounted) await act(async () => mounted.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(onSubmit: (code: string) => Promise<void>): Promise<HTMLDivElement> {
  const target = document.createElement('div');
  document.body.appendChild(target);
  host = target;
  await act(async () => {
    root = createRoot(target);
    root.render(<MagicCodeInput onSubmit={onSubmit} onResend={async () => {}} />);
  });
  return target;
}

async function typeCode(target: HTMLDivElement, code: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  const inputs = [...target.querySelectorAll('input')];
  for (const [index, digit] of [...code].entries()) {
    const input = inputs[index] as HTMLInputElement;
    await act(async () => {
      setter?.call(input, digit);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
}

async function tapVerify(target: HTMLDivElement) {
  const verify = target.querySelectorAll('button')[0] as HTMLButtonElement;
  await act(async () => {
    verify.click();
  });
}

describe('MagicCodeInput submitting a code (SC-1750)', () => {
  test('a refused code does not escape as an unhandled rejection', async () => {
    const target = await mount(() => Promise.reject(new Error('Invalid OTP')));
    await typeCode(target, '123456');
    await settle();
    expect(unhandled.map(String)).toEqual([]);
  });

  test('a Verify tap while the code is being checked sends nothing more', async () => {
    const calls: string[] = [];
    let finish: () => void = () => {};
    const target = await mount((code) => {
      calls.push(code);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await typeCode(target, '123456');
    await tapVerify(target);
    await settle();
    expect(calls).toEqual(['123456']);
    await act(async () => finish());
  });

  test('a refused code can be corrected and sent again', async () => {
    const calls: string[] = [];
    const target = await mount(async (code) => {
      calls.push(code);
      if (calls.length === 1) throw new Error('Invalid OTP');
    });
    await typeCode(target, '123456');
    await settle();
    await tapVerify(target);
    await settle();
    expect(calls).toEqual(['123456', '123456']);
  });
});
