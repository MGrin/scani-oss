import { describe, expect, test } from 'bun:test';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';

/**
 * A minus typed into a field that refuses one used to vanish without a word
 * (SC-1530). Typed for real — focus, then an `input` event through React's
 * own value setter — because the notice is state the static render never has.
 */

const NOTICE = 'Negative balances are not supported yet.';

function Field({ notice }: { notice?: string }) {
  const [value, setValue] = useState('');
  return <AmountInput value={value} onValueChange={setValue} negativeNotice={notice} />;
}

async function typeInto(text: string, notice?: string): Promise<{ html: string; shown: string }> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(<Field notice={notice} />));
  const input = host.querySelector('input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    input.focus();
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const html = host.innerHTML;
  const shown = input.value;
  await act(async () => root.unmount());
  host.remove();
  return { html, shown };
}

describe('AmountInput refusing a minus (SC-1530)', () => {
  test('says why when a minus is typed', async () => {
    const { html, shown } = await typeInto('-5', NOTICE);
    expect(shown).toBe('5');
    expect(html.includes(`>${NOTICE}</span>`)).toBe(true);
  });

  test('says nothing for a plain amount', async () => {
    const { html } = await typeInto('5', NOTICE);
    expect(html.includes(`>${NOTICE}</span>`)).toBe(false);
  });

  test('stays quiet where the caller gave no notice', async () => {
    const { html, shown } = await typeInto('-5');
    expect(shown).toBe('5');
    expect(html.includes('role="status"')).toBe(false);
  });
});
