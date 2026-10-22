import { describe, expect, test } from 'bun:test';
import { SETTLED_QUERY_STATE } from '@scani/ui/v3/lib/query-state';
import i18n from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { CaptureHeader } from '@/v3/components/capture/CaptureHeader';
import { CaptureSubmit } from '@/v3/components/capture/CaptureSubmit';
import { FileDropField } from '@/v3/components/capture/FileDropField';
import { type Integration, IntegrationsList } from '@/v3/components/capture/IntegrationsList';
import { KeyCanMoveMoneyNote } from '@/v3/components/capture/KeyCanMoveMoneyNote';
import { SelfHostedOnlyNotice } from '@/v3/components/capture/SelfHostedOnlyNotice';
import {
  connectHeaderDescription,
  connectInstructionsTitle,
  describeImportFileProblem,
  IMPORT_ACCEPT,
  IMPORT_FORMATS_KEY,
} from '@/v3/lib/capture-forms';
import { renderDesktop } from '../../../../../../packages/frontend/ui/tests/helpers/render-desktop';

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
        cancelTo="/"
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
        cancelTo="/"
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
        cancelTo="/"
        error="Could not reach the server. Check your connection."
      />
    );
    expect(markup).toContain('Could not reach the server. Check your connection.');
  });

  test('Cancel comes before the primary and leaves to where the header points (rule 9)', () => {
    const markup = render(
      <CaptureSubmit
        label="Upload and read it"
        blockers={[]}
        onSubmit={() => {}}
        stage={null}
        busyLabel="the upload"
        cancelTo="/documents"
        error={null}
      />
    );
    const cancel = markup.indexOf('href="/documents"');
    expect(cancel).toBeGreaterThan(-1);
    expect(markup.slice(cancel)).toContain('>Cancel<');
    expect(cancel).toBeLessThan(markup.indexOf('Upload and read it'));
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
        cancelTo="/"
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
    expect(markup).toContain(`${t(IMPORT_FORMATS_KEY)}, up to 8 MB`);
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

  test('the default way out is translated and says where it goes (rule 7)', () => {
    const markup = render(
      <CaptureHeader title="Upload a file" description="A statement or a screenshot." />
    );
    expect(markup).toContain('Back to home');
  });
});

function integration(
  providerKey: string,
  name: string,
  typeCode: string | null,
  availability: Integration['availability'] = 'available'
): Integration {
  return {
    providerKey,
    availability,
    credentialCanMoveMoney: false,
    selfHostedOnly: false,
    credentialNoun: 'key',
    statementExportFormats: [],
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

  // The third column holds the institution's own description ("Luxembourg-based
  // cryptocurrency exchange"), so a header promising what gets synced is a claim
  // the cells never back (SC-1256).
  test('the description column is headed for what it holds, not what syncs', () => {
    // The header row exists only on the desktop table; the phone list has none.
    const markup = renderDesktop(
      <StaticRouter location="/integrations">
        <IntegrationsList
          integrations={[integration('kraken', 'Kraken', 'crypto_exchange')]}
          query={SETTLED_QUERY_STATE}
        />
      </StaticRouter>
    );
    expect(markup).toContain('<table');
    expect(markup).toContain('>About<');
    expect(markup).not.toContain('What it syncs');
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

  // SC-1729: listed, so nobody wonders whether Scani knows bunq, and marked, so
  // nobody finds out only after pasting a key.
  test('a self-hosted-only service is listed and says so', () => {
    const markup = render(
      <IntegrationsList
        integrations={[integration('bunq', 'bunq', 'bank', 'self-hosted-only')]}
        query={SETTLED_QUERY_STATE}
      />,
      '/integrations'
    );
    expect(markup).toContain('bunq');
    // The mark is added to the kind, not swapped for it: a reader still sees
    // that bunq is a bank (design, SC-1729).
    expect(markup).toContain('Bank · Self-hosted only');
  });

  test('CONTROL: an available service carries no such mark', () => {
    const markup = render(
      <IntegrationsList
        integrations={[integration('kraken', 'Kraken', 'crypto_exchange')]}
        query={SETTLED_QUERY_STATE}
      />,
      '/integrations'
    );
    expect(markup).not.toContain('Self-hosted only');
  });
});

// SC-1729: bunq offers no read-only key, so the form says what the key can do
// before anyone pastes one.
describe('a key that can move money', () => {
  test('is named for what it can do, and for what Scani does with it', () => {
    const markup = render(<KeyCanMoveMoneyNote name="bunq" />, '/integrations/bunq');
    expect(markup).toContain('A bunq API key can also make payments');
    expect(markup).toContain('Scani only reads with it');
  });

  // The generic header promises "read-only permissions" and that keys "never
  // leave our workers". Above this warning the first contradicts it, and on a
  // self-hosted install the second is false: it is the user's server (design).
  test('the page header does not promise a read-only key', () => {
    const bunq = { ...integration('bunq', 'bunq', 'bank'), credentialCanMoveMoney: true };
    const header = connectHeaderDescription(t, bunq);
    expect(header).toBe(
      'Scani only reads with this key. It is encrypted at rest and stays on the server Scani runs on.'
    );
    expect(header).not.toContain('Read-only permissions');
    expect(header).not.toContain('our workers');
  });

  // A self-hosted-only service is only ever connected on the user's own
  // server, so "never leave our workers" is wrong there whatever the key can
  // do (design, SC-1729; SC-1731).
  test('a self-hosted-only service says the key stays on the server Scani runs on', () => {
    const one = { ...integration('acme', 'Acme', 'bank'), selfHostedOnly: true };
    const header = connectHeaderDescription(t, one);
    expect(header).toBe(
      'Scani only reads with this key. It is encrypted at rest and stays on the server Scani runs on.'
    );
    expect(header).not.toContain('our workers');
  });

  // Investec takes a client ID, a secret and an API key (design, SC-1731).
  test('a service that takes several credentials says "these credentials"', () => {
    const field = (name: string) => ({ name, label: name, type: 'password', sensitive: true });
    const investec = {
      ...integration('investec', 'Investec', 'bank'),
      selfHostedOnly: true,
      credentialFields: [field('clientId'), field('clientSecret'), field('apiKey')],
    } as Integration;
    expect(connectHeaderDescription(t, investec)).toBe(
      'Scani only reads with these credentials. They are encrypted at rest and stay on the server Scani runs on.'
    );
  });

  // Fio calls its credential a token; the header uses the provider's own noun
  // (design, SC-1732).
  test('a service whose one credential is a token says "this token"', () => {
    const fio = {
      ...integration('fio', 'Fio banka', 'bank'),
      selfHostedOnly: true,
      credentialNoun: 'token',
      credentialFields: [{ name: 'token', label: 'API token', type: 'password', sensitive: true }],
    } as Integration;
    expect(connectHeaderDescription(t, fio)).toBe(
      'Scani only reads with this token. It is encrypted at rest and stays on the server Scani runs on.'
    );
  });

  // "Where to get them" over one field reads wrong (design, SC-1732).
  test('the steps are titled "Where to get it" over one credential, "them" over several', () => {
    const field = (name: string) => ({ name, label: name, type: 'password', sensitive: true });
    const one = { ...integration('fio', 'Fio banka', 'bank'), credentialFields: [field('token')] };
    const three = {
      ...integration('investec', 'Investec', 'bank'),
      credentialFields: [field('clientId'), field('clientSecret'), field('apiKey')],
    };
    expect(connectInstructionsTitle(t, one as Integration)).toBe('Where to get it');
    expect(connectInstructionsTitle(t, three as Integration)).toBe('Where to get them');
  });

  test('CONTROL: a service with a read-only key keeps the usual header', () => {
    expect(connectHeaderDescription(t, integration('kraken', 'Kraken', 'crypto_exchange'))).toBe(
      t('v3.capture.integration.permissions')
    );
  });
});

// "Read-only API keys" is a claim about the keys. bunq offers no read-only key,
// and an exchange key is read-only only if its owner chose that. What Scani
// controls is what it does with a key, so that is what the copy says (design,
// SC-1729).
describe('what the copy says about keys', () => {
  test('the services list says what Scani does with a key', () => {
    expect(t('v3.capture.integration.listSubtitle')).toBe(
      'Scani only reads with the keys you add, and encrypts them at rest. Balances sync hourly. Connecting the same service again replaces its keys.'
    );
  });

  test('neither the list nor the add sheet calls the keys read-only', () => {
    expect(t('v3.capture.integration.listSubtitle')).not.toContain('Read-only API keys');
    expect(t('v3.capture.route.exchange.description')).not.toContain('Read-only API keys');
  });
});

describe('a self-hosted-only service on the hosted product', () => {
  const bunq = integration('bunq', 'bunq', 'bank', 'self-hosted-only');

  test('says why it cannot be connected here, naming the service', () => {
    const markup = render(<SelfHostedOnlyNotice integration={bunq} />, '/integrations/bunq');
    expect(markup).toContain('Available on self-hosted Scani');
    expect(markup).toContain(
      'bunq lets its personal API key be used only in software you run yourself'
    );
  });

  test('asks for no key: there is no field to paste one into', () => {
    const markup = render(<SelfHostedOnlyNotice integration={bunq} />, '/integrations/bunq');
    expect(markup).not.toContain('<input');
    expect(markup).not.toContain('<textarea');
  });

  test('offers the way that does work here: a statement file', () => {
    const markup = render(<SelfHostedOnlyNotice integration={bunq} />, '/integrations/bunq');
    expect(markup).toContain('href="/import"');
    expect(markup).toContain('Upload a statement instead');
  });

  // mgrin kept bunq self-hosted only (2026-10-11), so this notice is how a
  // hosted bunq customer gets their data in: it names the file to export.
  test('names the statement formats to export from the service', () => {
    const withExport = { ...bunq, statementExportFormats: ['MT940', 'CSV'] };
    const markup = render(<SelfHostedOnlyNotice integration={withExport} />, '/integrations/bunq');
    expect(markup).toContain('Export a statement from bunq as MT940 or CSV and upload it here');
  });

  // The reason is the provider's own term, not bunq's (design, SC-1731).
  test("gives Investec's own reason, not bunq's", () => {
    const investec = integration('investec', 'Investec', 'bank', 'self-hosted-only');
    const markup = render(
      <SelfHostedOnlyNotice integration={investec} />,
      '/integrations/investec'
    );
    expect(markup).toContain(
      'Investec issues these credentials for you or your business only, so the hosted Scani can'
    );
    expect(markup).toContain('Run Scani on your own server to connect Investec');
    expect(markup).not.toContain('personal API key');
  });

  // Fio's term: the customer is liable for any use of the token by someone
  // else (VSP IB čl. XIII odst. 4; SC-1732).
  test("gives Fio's own reason, and names the CSV statement to upload", () => {
    const fio = {
      ...integration('fio', 'Fio banka', 'bank', 'self-hosted-only'),
      statementExportFormats: ['CSV'],
    };
    const markup = render(<SelfHostedOnlyNotice integration={fio} />, '/integrations/fio');
    expect(markup).toContain(
      'Fio banka holds you liable for anything done with your token by someone else, so the hosted Scani doesn'
    );
    expect(markup).toContain('Export a statement from Fio banka as CSV and upload it here');
    expect(markup).not.toContain('personal API key');
  });

  test('a service with no reason of its own says only where it can be connected', () => {
    const acme = integration('acme', 'Acme', 'bank', 'self-hosted-only');
    const markup = render(<SelfHostedOnlyNotice integration={acme} />, '/integrations/acme');
    expect(markup).toContain('Acme can be connected only on self-hosted Scani.');
    expect(markup).not.toContain('personal API key');
  });

  test('CONTROL: a service that names no format keeps the general sentence', () => {
    const markup = render(<SelfHostedOnlyNotice integration={bunq} />, '/integrations/bunq');
    expect(markup).toContain('or upload a statement file instead');
    expect(markup).not.toContain('Export a statement from');
  });
});
