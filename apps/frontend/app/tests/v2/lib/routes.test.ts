import { describe, expect, test } from 'bun:test';
import { resolveActiveNavPath, V2_ROUTES } from '../../../src/v2/lib/routes';

describe('resolveActiveNavPath', () => {
  test('the dashboard lights only on the root, never as a prefix', () => {
    expect(resolveActiveNavPath('/')).toBe('/');
    expect(resolveActiveNavPath('/holdings')).toBe('/holdings');
    expect(resolveActiveNavPath('/settings')).toBeNull();
  });

  // The reported bug: `/payments` is a prefix of `/payments/recurring`, so
  // plain prefix matching lit Overview on the recurring-payments page too.
  test('the more specific entry wins when one nav path prefixes another', () => {
    expect(resolveActiveNavPath(V2_ROUTES.payments)).toBe(V2_ROUTES.payments);
    expect(resolveActiveNavPath(V2_ROUTES.paymentsList)).toBe(V2_ROUTES.paymentsList);
  });

  // The other half of the same report: with `end` set to fix the above, a
  // payment's own page lit nothing at all.
  test('detail, edit and create pages inherit their parent list', () => {
    expect(resolveActiveNavPath(V2_ROUTES.paymentDetail('abc'))).toBe(V2_ROUTES.paymentsList);
    expect(resolveActiveNavPath(V2_ROUTES.paymentEdit('abc'))).toBe(V2_ROUTES.paymentsList);
    expect(resolveActiveNavPath(V2_ROUTES.paymentCreate)).toBe(V2_ROUTES.paymentsList);
    expect(resolveActiveNavPath(V2_ROUTES.accountDetail('abc'))).toBe(V2_ROUTES.accounts);
    expect(resolveActiveNavPath(V2_ROUTES.vendorDetail('abc'))).toBe(V2_ROUTES.vendors);
  });

  // A document's own page and the upload form both live under the Files
  // list, which is what keeps Files lit while you look at one file.
  test('a document and the upload form inherit the Files list', () => {
    expect(resolveActiveNavPath(V2_ROUTES.files)).toBe(V2_ROUTES.files);
    expect(resolveActiveNavPath(V2_ROUTES.documentDetail('abc'))).toBe(V2_ROUTES.files);
    expect(resolveActiveNavPath(V2_ROUTES.documentUpload)).toBe(V2_ROUTES.files);
  });

  // The invoice-prefilled form is the same page with a query string, so it
  // has to keep lighting Recurring Payments.
  test('the invoice-prefilled create page is still the create page', () => {
    const href = V2_ROUTES.paymentCreateFromExtraction('a b/c');
    expect(href).toBe(`${V2_ROUTES.paymentCreate}?fromExtraction=a%20b%2Fc`);
    expect(resolveActiveNavPath(V2_ROUTES.paymentCreate)).toBe(V2_ROUTES.paymentsList);
  });

  test('matching is on whole path segments, not raw string prefixes', () => {
    expect(resolveActiveNavPath('/payments-archive')).toBeNull();
    expect(resolveActiveNavPath('/holdingsomething')).toBeNull();
  });

  test('pages outside the nav leave every entry unlit', () => {
    expect(resolveActiveNavPath(V2_ROUTES.settings)).toBeNull();
    expect(resolveActiveNavPath(V2_ROUTES.integrations)).toBeNull();
  });
});
