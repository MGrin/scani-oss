import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { FormActions } from '@/v3/components/form/FormSheet';
import { PriceEditHistory } from '@/v3/components/tokens/EditCustomTokenPriceSheet';

const t = i18n.t.bind(i18n);

/**
 * The two halves of the custom-token sheets a test can actually reach.
 *
 * Neither sheet is rendered whole here, and that is structural rather than
 * lazy: both shells are Radix dialogs, and Radix renders NOTHING under
 * `renderToStaticMarkup` — an assertion against the full sheet would pass over
 * an empty string. So the parts that carry the behaviour are components of
 * their own, which is the same split `CaptureList` and `PeekHeader` make.
 */

type HistoryRows = Parameters<typeof PriceEditHistory>[0]['rows'];

function row(over: Partial<HistoryRows[number]> = {}): HistoryRows[number] {
  return {
    id: 'edit-1',
    tokenId: 'token-1',
    baseTokenId: 'base-1',
    previousPrice: '100',
    newPrice: '128.4',
    editedByUserId: 'user-1',
    reason: 'Q4 2025 valuation round',
    createdAt: new Date('2026-08-18T09:00:00.000Z'),
    editorEmail: 'someone@example.com',
    editorName: 'Someone',
    baseCurrencySymbol: 'EUR',
    ...over,
  } as HistoryRows[number];
}

describe('FormActions — a disabled button always says why', () => {
  test('nothing missing is a live button and no explanation', () => {
    const markup = renderToStaticMarkup(
      <FormActions
        submitLabel="Save price"
        pendingLabel="Saving…"
        onSubmit={() => {}}
        onCancel={() => {}}
        blockers={[]}
        pending={false}
        error={null}
      />
    );
    expect(markup).toContain('Save price');
    // `disabled=""`, not the substring: every `Button` carries
    // `disabled:opacity-50` in its class list whether or not it is disabled.
    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain('To continue');
  });

  test('a blocked form names every missing thing next to the dead button', () => {
    // v2's version of this greys out behind a five-clause boolean and offers
    // the reader no way to find out which clause. That is the rewrite.
    const markup = renderToStaticMarkup(
      <FormActions
        submitLabel="Create token"
        pendingLabel="Creating…"
        onSubmit={() => {}}
        onCancel={() => {}}
        blockers={['enter a symbol', 'choose a currency']}
        pending={false}
        error={null}
      />
    );
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('To continue: enter a symbol, choose a currency.');
  });

  test('in flight it says so and both buttons are dead', () => {
    const markup = renderToStaticMarkup(
      <FormActions
        submitLabel="Create token"
        pendingLabel="Creating…"
        onSubmit={() => {}}
        onCancel={() => {}}
        blockers={[]}
        pending={true}
        error={null}
      />
    );
    expect(markup).toContain('Creating…');
    expect(markup).not.toContain('Create token');
    // Cancel too: the mutation is already away, and a cancel that only closed
    // the sheet would claim it had stopped something.
    expect(markup.match(/disabled=""/g)?.length).toBe(2);
  });

  test('a failure is a sentence under the button, not a toast', () => {
    // §2.5: `showError` opens with "Something went wrong", and a toast over the
    // tab bar is gone in four seconds — before the reader has looked back up
    // from the field they were about to fix.
    const markup = renderToStaticMarkup(
      <FormActions
        submitLabel="Create token"
        pendingLabel="Creating…"
        onSubmit={() => {}}
        onCancel={() => {}}
        blockers={[]}
        pending={false}
        error="ACME already exists."
      />
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('ACME already exists.');
  });
});

/**
 * The edit log is open rather than behind a "Show edit history" toggle, which
 * is the reason this form is a rewrite and not a move: the price on screen is a
 * number a stranger typed, and who typed it is the question the reader has
 * before overwriting it.
 */
describe('PriceEditHistory', () => {
  test('an empty log says so without claiming the token is unpriced', () => {
    const markup = renderToStaticMarkup(<PriceEditHistory rows={[]} isLoading={false} t={t} />);
    expect(markup).toContain('No price has been changed yet.');
  });

  test('loading is announced rather than drawn as an empty list', () => {
    const markup = renderToStaticMarkup(<PriceEditHistory rows={[]} isLoading={true} t={t} />);
    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('No price has been changed yet.');
  });

  test('a row is the move, who made it and why', () => {
    const markup = renderToStaticMarkup(
      <PriceEditHistory rows={[row()]} isLoading={false} t={t} />
    );
    expect(markup).toContain('€100.00');
    expect(markup).toContain('€128.40');
    expect(markup).toContain('Q4 2025 valuation round');
    expect(markup).toContain('someone@example.com');
  });

  test('the first price ever set has no previous one, and says so', () => {
    const markup = renderToStaticMarkup(
      <PriceEditHistory rows={[row({ previousPrice: null })]} isLoading={false} t={t} />
    );
    // `Numeric`'s placeholder — an em dash plus a spoken absence, never "€0.00",
    // which would read as the token having been worthless.
    expect(markup).toContain('—');
    expect(markup).not.toContain('€0.00');
  });

  test('a sub-cent price keeps its precision rather than rounding to nothing', () => {
    // V3-12: a custom token can be a share at 128.40 or a unit at 0.0000042,
    // and two decimals on the second reports a real price as no price.
    const markup = renderToStaticMarkup(
      <PriceEditHistory
        rows={[row({ previousPrice: null, newPrice: '0.0000042' })]}
        isLoading={false}
        t={t}
      />
    );
    expect(markup).toContain('0.0000042');
  });

  test('an edit with no reason says nobody gave one, and falls back to a name', () => {
    const markup = renderToStaticMarkup(
      <PriceEditHistory rows={[row({ reason: null, editorEmail: null })]} isLoading={false} t={t} />
    );
    expect(markup).toContain('No reason given');
    expect(markup).toContain('Someone');
  });

  test('an editor with neither email nor name is Unknown, not blank', () => {
    const markup = renderToStaticMarkup(
      <PriceEditHistory
        rows={[row({ editorEmail: null, editorName: null })]}
        isLoading={false}
        t={t}
      />
    );
    expect(markup).toContain('Unknown');
  });
});
