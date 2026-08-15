import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { useBaseCurrency } from '../../src/contexts/BaseCurrencyContext';

const SRC = join(import.meta.dir, '../../src');

function read(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8');
}

function Consumer() {
  const { symbol } = useBaseCurrency();
  return <span>{symbol}</span>;
}

describe('useBaseCurrency', () => {
  test('throws outside a provider instead of serving a USD placeholder', () => {
    // The whole point of SC-36: the old context default was a complete
    // `{ symbol: 'USD' }`, so a subtree mounted without the provider priced a
    // portfolio in the wrong currency and reported nothing.
    expect(() => renderToStaticMarkup(<Consumer />)).toThrow(/BaseCurrencyProvider/);
  });
});

describe('provider placement', () => {
  test('BaseCurrencyProvider is mounted in App, above the v2/v3 split', () => {
    const app = read('App.tsx');
    expect(app).toInclude("import { BaseCurrencyProvider } from '@/contexts/BaseCurrencyContext'");
    expect(app).toInclude('<BaseCurrencyProvider>');
  });

  test('neither app tree mounts its own provider', () => {
    // Two providers reading the same endpoint drift, and a nested one would
    // re-fire `users.getBaseCurrency` for the subtree under it.
    for (const file of ['v2/V2App.tsx', 'v3/V3App.tsx']) {
      expect(read(file)).not.toInclude('BaseCurrencyProvider');
    }
  });

  test('the v3 tree reads the base currency through the hook, never the query', () => {
    for (const file of ['v3/pages/MoneyPage.tsx', 'v3/pages/PaymentFormPage.tsx']) {
      expect(read(file)).not.toInclude('users.getBaseCurrency');
    }
  });
});
