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
  test('BaseCurrencyProvider is mounted in App, above the lazily loaded tree', () => {
    const app = read('App.tsx');
    expect(app).toInclude("import { BaseCurrencyProvider } from '@/contexts/BaseCurrencyContext'");
    expect(app).toInclude('<BaseCurrencyProvider>');
  });

  test('the app tree does not mount its own provider', () => {
    // Two providers reading the same endpoint drift, and a nested one would
    // re-fire `users.getBaseCurrency` for the subtree under it. This used to
    // check both trees; the classic one went in SC-423.
    expect(read('v3/V3App.tsx')).not.toInclude('BaseCurrencyProvider');
  });

  test('the v3 tree reads the base currency through the hook, never the query', () => {
    for (const file of ['v3/pages/MoneyPage.tsx', 'v3/pages/PaymentFormPage.tsx']) {
      expect(read(file)).not.toInclude('users.getBaseCurrency');
    }
  });
});

describe('the base-currency token carries the id and not the name', () => {
  // Comments stripped: this asks what the provider DOES, and the file's own
  // docblock names the shape it stopped doing — which would satisfy a plain
  // substring search and make the check below vacuously red.
  const source = read('contexts/BaseCurrencyContext.tsx')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  /**
   * SC-419. The provider used to spread `name: baseCurrency.name` over the
   * name `createCurrencyToken` derives, so a reader saw the CLDR name for one
   * frame and the English row from Postgres afterwards. The base currency is
   * always fiat, so the derived name is correct for every row there is.
   *
   * The `id` half is the control: it is why the spread exists at all, and a
   * test that only asserted the absence would pass over a deleted spread.
   */
  test('the real id is still carried through', () => {
    expect(source).toInclude('id: baseCurrency.id');
  });

  test('the stored name is not', () => {
    expect(source).not.toInclude('baseCurrency.name');
  });
});
