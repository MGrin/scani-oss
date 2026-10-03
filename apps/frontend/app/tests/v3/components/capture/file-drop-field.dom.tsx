import { afterEach, describe, expect, test } from 'bun:test';
import { UPLOADED_FILE_MAX_BYTES } from '@scani/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileDropField } from '@/v3/components/capture/FileDropField';

/**
 * SC-1492. A file over the upload limit was refused only after the upload, by
 * the presign route as a raw issue list or by the worker minutes later. The
 * field now refuses it when it is chosen, in the place a wrong format is
 * refused. A file of exactly the limit is the control: without it, a field
 * refusing every file would pass the first test.
 *
 * Runs in the DOM process `packages/frontend/ui/tests/helpers/dom-specs.ts`
 * starts; assertions read strings, never nodes (see `mount-dom.ts`).
 */

let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function choose(file: File): Promise<{ chosen: (File | null)[]; markup: string }> {
  const chosen: (File | null)[] = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <FileDropField
        inputId="import-file"
        accept=".csv"
        file={null}
        onFile={(next) => chosen.push(next)}
        validate={() => null}
        formats="CSV"
        prompt="Choose a file, or drop one here"
      />
    );
  });
  const input = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  return { chosen, markup: document.body.innerHTML };
}

describe('the file field refuses a file over the upload limit', () => {
  test('an oversized file is refused in place, naming its size and the limit', async () => {
    const file = new File([new Uint8Array(13_002_342)], 'statement.csv', { type: 'text/csv' });
    const { chosen, markup } = await choose(file);
    expect(chosen.length).toBe(1);
    expect(chosen[0] === null).toBe(true);
    expect(markup).toContain('This file is 12 MB. The limit is 8 MB.');
    expect(markup).toContain('role="alert"');
  });

  test('CONTROL: a file of exactly the limit is taken', async () => {
    const file = new File([new Uint8Array(UPLOADED_FILE_MAX_BYTES)], 'statement.csv', {
      type: 'text/csv',
    });
    const { chosen, markup } = await choose(file);
    expect(chosen.length).toBe(1);
    expect(chosen[0] === file).toBe(true);
    expect(markup).not.toContain('The limit is');
  });
});
