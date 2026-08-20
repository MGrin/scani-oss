import { describe, expect, test } from 'bun:test';
import { SETTLED_QUERY_STATE } from '@scani/ui/v3/lib/query-state';
import i18n from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { CaptureHeader } from '@/v3/components/capture/CaptureHeader';
import { CaptureSubmit } from '@/v3/components/capture/CaptureSubmit';
import { FileDropField } from '@/v3/components/capture/FileDropField';
import { type Integration, IntegrationsList } from '@/v3/components/capture/IntegrationsList';
import {
  describeImportFileProblem,
  IMPORT_ACCEPT,
  IMPORT_FORMATS_KEY,
} from '@/v3/lib/capture-forms';

// Resolved through the real instance against the shipped `en.json`.
const t = i18n.t.bind(i18n);

/**
 * The four capture forms' shared parts, rendered rather than reasoned about.
 *
 * `StaticRouter` everywhere, as in the rest of these tests: `Link` and
 * `useNavigate` need a router, and the memory router runs a `useLayoutEffect`
 * React warns about under the server renderer.
 */
function render(node: React.ReactNode, location = '/import'): string {
  return renderToStaticMarkup(<StaticRouter location={location}>{node}</StaticRouter>);
}

describe('the submit row', () => {
  test('a disabled button always says what is missing', () => {
    // The ticket's rule, and the one v2 breaks in all four of these forms.
    const markup = render(
      <CaptureSubmit
        label="Upload and read it"
        blockers={['choose an account', 'choose a file to upload']}
        onSubmit={() => {}}
        stage={null}
        busyLabel="the upload"
        error={null}
      />
    );
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('To continue: choose an account, choose a file to upload.');
  });

  test('an unblocked form offers the button and explains nothing', () => {
    const markup = render(
      <CaptureSubmit
        label="Upload and read it"
        blockers={[]}
        onSubmit={() => {}}
        stage={null}
        busyLabel="the upload"
        error={null}
      />
    );
    expect(markup).not.toContain('To continue');
    expect(markup).not.toContain('disabled=""');
  });

  test('the last failure is readable in place, not only in a toast that has gone', () => {
    const markup = render(
      <CaptureSubmit
        label="Upload and read it"
        blockers={[]}
        onSubmit={() => {}}
        stage={null}
        busyLabel="the upload"
        error="Could not reach the server. Check your connection."
      />
    );
    expect(markup).toContain('Could not reach the server. Check your connection.');
  });

  test('a submission in flight replaces the button rather than spinning it', () => {
    // And draws nothing in its first 300ms — the ramp's own first band, which
    // is why there is no spinner in the markup at t=0 either.
    const markup = render(
      <CaptureSubmit
        label="Upload and read it"
        blockers={[]}
        onSubmit={() => {}}
        stage="upload"
        busyLabel="the upload"
        error={null}
      />
    );
    expect(markup).not.toContain('Upload and read it');
    expect(markup).not.toContain('animate-spin');
  });
});

describe('the file field', () => {
  test('says what it takes before anything is chosen', () => {
    const markup = render(
      <FileDropField
        inputId="import-file"
        accept={IMPORT_ACCEPT}
        file={null}
        onFile={() => {}}
        validate={(filename) => describeImportFileProblem(t, filename)}
        formats={t(IMPORT_FORMATS_KEY)}
        prompt="Choose a file, or drop one here"
      />
    );
    expect(markup).toContain('Choose a file, or drop one here');
    expect(markup).toContain(t(IMPORT_FORMATS_KEY));
    expect(markup).toContain(`accept="${IMPORT_ACCEPT}"`);
  });

  test('a chosen file reads back by name and size, with a way to undo it', () => {
    const file = new File(['x'.repeat(2048)], 'kraken-balances.png', { type: 'image/png' });
    const markup = render(
      <FileDropField
        inputId="import-file"
        accept={IMPORT_ACCEPT}
        file={file}
        onFile={() => {}}
        validate={(filename) => describeImportFileProblem(t, filename)}
        formats={t(IMPORT_FORMATS_KEY)}
        prompt="Choose a file, or drop one here"
      />
    );
    expect(markup).toContain('kraken-balances.png');
    expect(markup).toContain('2 KB');
    expect(markup).toContain('Remove kraken-balances.png');
  });
});

describe('the capture header', () => {
  test('the way out is a destination, not a history entry', () => {
    // These screens are reached from a sheet that has already closed, so
    // "back" is not something the page can know.
    const markup = render(
      <CaptureHeader title="Upload a file" description="A statement or a screenshot." />
    );
    expect(markup).toContain('href="/"');
    expect(markup).toContain('Upload a file');
  });
});

function integration(providerKey: string, name: string, typeCode: string | null): Integration {
  return {
    providerKey,
    credentialFields: [],
    instructions: { steps: [] },
    institution: {
      id: `inst-${providerKey}`,
      name,
      description: `${name} balances`,
      website: null,
      logoUrl: null,
      type: typeCode ? { code: typeCode, name: typeCode } : null,
    },
  } as Integration;
}

describe('the integrations list', () => {
  /**
   * The defect this port fixes, as an assertion. v2 renders four hard-coded
   * category sections and draws only providers whose institution type matches
   * one of them, so a provider seeded with any other type is absent from the
   * only screen that can connect it.
   */
  test('shows a provider whose institution type is not one of the four v2 knows', () => {
    const markup = render(
      <IntegrationsList
        integrations={[
          integration('kraken', 'Kraken', 'crypto_exchange'),
          integration('acme-pension', 'Acme Pension', 'pension_provider'),
        ]}
        query={SETTLED_QUERY_STATE}
      />,
      '/integrations'
    );
    expect(markup).toContain('Kraken');
    expect(markup).toContain('Acme Pension');
    expect(markup).toContain('Other');
  });

  test('a provider with no institution type at all is still listed', () => {
    const markup = render(
      <IntegrationsList
        integrations={[integration('mystery', 'Mystery Bank', null)]}
        query={SETTLED_QUERY_STATE}
      />,
      '/integrations'
    );
    expect(markup).toContain('Mystery Bank');
  });
});
