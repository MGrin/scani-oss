import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import {
  buildCredentials,
  buildWalletImportInput,
  describeCaptureStage,
  describeCredentialBlockers,
  describeImportBlockers,
  describeImportFileProblem,
  describeInvoiceBlockers,
  describeInvoiceFileProblem,
  describeWalletAddressProblem,
  describeWalletImportBlockers,
  emptyWalletImportDraft,
  formatFileSize,
  IMPORT_ACCEPT,
  integrationCategoryLabel,
  planImportFile,
  planInvoiceFile,
} from '@/v3/lib/capture-forms';
import { type AccountTargetDraft, emptyAccountTarget } from '@/v3/lib/manual-entry';

const t = i18n.t.bind(i18n);

// Resolved through the real instance against the shipped `en.json`.

function chosenAccount(): AccountTargetDraft {
  return { ...emptyAccountTarget(), institutionId: 'inst-1', accountId: 'acc-1' };
}

describe('what a file is', () => {
  test('an image or a PDF goes to the screenshot parser', () => {
    expect(planImportFile({ name: 'balances.png', type: 'image/png' })).toEqual({
      purpose: 'screenshot',
      contentType: 'image/png',
    });
    expect(planImportFile({ name: 'statement.PDF', type: '' })).toEqual({
      purpose: 'screenshot',
      contentType: 'application/pdf',
    });
  });

  test('the browser wins on content type for an image, and loses for a PDF', () => {
    // R2's presigner signs whatever we send, so an image uploads under the type
    // the browser reported. A PDF's type is fixed because the parse job
    // dispatches on it.
    expect(planImportFile({ name: 'shot.jpg', type: 'image/webp' })?.contentType).toBe(
      'image/webp'
    );
    expect(planImportFile({ name: 'doc.pdf', type: 'text/plain' })?.contentType).toBe(
      'application/pdf'
    );
  });

  test('a browser that reports no type at all still produces a signable one', () => {
    expect(planImportFile({ name: 'shot.png', type: '' })?.contentType).toBe('image/png');
    expect(planImportFile({ name: 'export.csv', type: '' })?.contentType).toBe('text/plain');
  });

  test('a statement names which of the three parsers reads it', () => {
    expect(planImportFile({ name: 'a.csv', type: 'text/csv' })?.format).toBe('csv');
    expect(planImportFile({ name: 'a.tsv', type: '' })?.format).toBe('csv');
    expect(planImportFile({ name: 'a.ofx', type: '' })?.format).toBe('ofx');
    expect(planImportFile({ name: 'a.qif', type: '' })?.format).toBe('qif');
    // v2's mapping, kept deliberately: `.qfx` is read by the CSV parser. Which
    // parser sees a file is the worker's contract, not this port's to change.
    expect(planImportFile({ name: 'a.qfx', type: '' })?.format).toBe('csv');
  });

  test('anything else is refused, and the refusal names what would work', () => {
    expect(planImportFile({ name: 'notes.docx', type: '' })).toBeNull();
    const problem = describeImportFileProblem(t, 'notes.docx');
    expect(problem).toContain('.docx');
    expect(problem).toContain('CSV');
    expect(describeImportFileProblem(t, 'balances.png')).toBeNull();
  });

  test('a file with no extension is refused by name rather than by silence', () => {
    expect(describeImportFileProblem(t, 'screenshot')).toContain('no file extension');
  });

  test('every extension the accept attribute offers is one the planner reads', () => {
    // The two lists drifting apart is how a `.gif` becomes offerable in the
    // file dialog and rejected the moment it is chosen.
    for (const ext of IMPORT_ACCEPT.split(',')) {
      expect(planImportFile({ name: `file${ext}`, type: '' })).not.toBeNull();
    }
  });

  test('an invoice is a fixed table, because the parse job dispatches on the type', () => {
    expect(planInvoiceFile({ name: 'bill.pdf' })).toEqual({ contentType: 'application/pdf' });
    expect(planInvoiceFile({ name: 'photo.HEIC' })).toEqual({ contentType: 'image/heic' });
    expect(planInvoiceFile({ name: 'export.csv' })).toBeNull();
    expect(describeInvoiceFileProblem(t, 'export.csv')).toContain('PDF');
  });
});

describe('file size', () => {
  test('reads at the scale a person thinks in', () => {
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(900)).toBe('900 B');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(12 * 1024 * 1024)).toBe('12 MB');
  });

  test('a size it cannot state is stated as nothing rather than as NaN', () => {
    expect(formatFileSize(Number.NaN)).toBe('');
    expect(formatFileSize(-1)).toBe('');
  });
});

describe('the import blockers', () => {
  test('name the account and the file separately, in the order the form asks', () => {
    expect(describeImportBlockers(t, emptyAccountTarget(), null)).toEqual([
      'choose where the account is held',
      'choose an account',
      'choose a file to upload',
    ]);
  });

  test('a file without an account still names only what is missing', () => {
    expect(describeImportBlockers(t, emptyAccountTarget(), { name: 'a.csv' })).toEqual([
      'choose where the account is held',
      'choose an account',
    ]);
  });

  test('are empty once both halves are answered', () => {
    expect(describeImportBlockers(t, chosenAccount(), { name: 'a.csv' })).toEqual([]);
  });

  test('the invoice asks for one thing and says so', () => {
    expect(describeInvoiceBlockers(t, null)).toEqual(['choose the invoice to upload']);
    expect(describeInvoiceBlockers(t, { name: 'bill.pdf' })).toEqual([]);
  });
});

describe('the wallet form', () => {
  const EVM = '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0';
  const BITCOIN_LEGACY = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
  const BITCOIN_BECH32 = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  const SOLANA = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const TRON = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
  const TON = 'EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N';

  test('an empty address is named, not greyed out', () => {
    expect(describeWalletImportBlockers(t, emptyWalletImportDraft())).toEqual([
      'enter the wallet address',
    ]);
    expect(describeWalletAddressProblem(t, '')).toBeNull();
  });

  // One address per validator in `packages/clients/providers`. If one of these
  // stops passing, the form has started refusing a chain Scani can read.
  test.each([
    ['Ethereum', EVM],
    ['Bitcoin (legacy)', BITCOIN_LEGACY],
    ['Bitcoin (bech32)', BITCOIN_BECH32],
    ['Solana', SOLANA],
    ['Tron', TRON],
    ['TON', TON],
  ])('a real %s address passes', (_chain, address) => {
    expect(describeWalletAddressProblem(t, address)).toBeNull();
    expect(describeWalletImportBlockers(t, { address, displayName: '' })).toEqual([]);
  });

  // D-2: this was accepted, enqueued, and failed later on `/jobs` behind a row
  // labelled `auto · not-an…ress`.
  test('prose is rejected at the field, and the field says what an address looks like', () => {
    const problem = describeWalletAddressProblem(t, 'not-an-address');
    expect(problem).toContain('0x and 40 hexadecimal characters');
    expect(problem).toContain('bc1');
    expect(describeWalletImportBlockers(t, { address: 'not-an-address', displayName: '' })).toEqual(
      ['check the wallet address']
    );
  });

  // Where the chain is unambiguous from the prefix, name it: "not a finished
  // Ethereum address" is a correction, "not an address" is a verdict.
  test('a truncated EVM address is named as an incomplete Ethereum one', () => {
    const problem = describeWalletAddressProblem(t, '0xabc');
    expect(problem).toContain('Ethereum');
    expect(problem).toContain('42 in all');
    expect(problem).toContain('5 characters');
    expect(describeWalletImportBlockers(t, { address: '0xabc', displayName: '' })).toEqual([
      'finish the wallet address',
    ]);
  });

  test('an EVM address one character short is rejected, not rounded up', () => {
    expect(describeWalletAddressProblem(t, EVM.slice(0, -1))).toContain('Ethereum');
  });

  test('a truncated bech32 address is named as an incomplete Bitcoin one', () => {
    expect(describeWalletAddressProblem(t, 'bc1qar0srrr')).toContain('Bitcoin');
  });

  test('sends a trimmed address, an optional name, and auto chain detection', () => {
    expect(
      buildWalletImportInput({ address: `  ${EVM}  `, displayName: '  Cold storage ' }, 'req-1')
    ).toEqual({
      address: EVM,
      displayName: 'Cold storage',
      chain: 'auto',
      requestId: 'req-1',
    });
  });

  test('an empty name is absent rather than an empty string', () => {
    const input = buildWalletImportInput({ address: EVM, displayName: '   ' }, 'req-1');
    expect(input?.displayName).toBeUndefined();
  });

  test('an incomplete draft builds nothing at all', () => {
    expect(buildWalletImportInput(emptyWalletImportDraft(), 'req-1')).toBeNull();
  });

  test('an unrecognised address builds nothing, so no job can be enqueued for it', () => {
    expect(
      buildWalletImportInput({ address: 'not-an-address', displayName: '' }, 'req-1')
    ).toBeNull();
  });
});

describe('the credential form', () => {
  const fields = [
    { name: 'apiKey', label: 'API key', required: true },
    { name: 'apiSecret', label: 'API secret', required: true },
    { name: 'passphrase', label: 'Passphrase', required: false },
  ];

  test('names every required field that is still empty, by its own label', () => {
    expect(describeCredentialBlockers(fields, {}, t)).toEqual([
      'enter the API key',
      'enter the API secret',
    ]);
  });

  test('whitespace is not an answer', () => {
    expect(describeCredentialBlockers(fields, { apiKey: '  ', apiSecret: 'x' }, t)).toEqual([
      'enter the API key',
    ]);
  });

  test('an optional field never blocks', () => {
    expect(describeCredentialBlockers(fields, { apiKey: 'k', apiSecret: 's' }, t)).toEqual([]);
  });

  test('an empty optional field is omitted rather than sent as an empty string', () => {
    // A stored empty passphrase is a credential the provider will reject on
    // every sync from then on.
    expect(buildCredentials(fields, { apiKey: 'k', apiSecret: 's', passphrase: '' })).toEqual({
      apiKey: 'k',
      apiSecret: 's',
    });
  });

  test('a value for a field the manifest does not declare is dropped', () => {
    expect(buildCredentials(fields, { apiKey: 'k', apiSecret: 's', stale: 'x' })).toEqual({
      apiKey: 'k',
      apiSecret: 's',
    });
  });
});

describe('integration categories', () => {
  test('name each kind of place', () => {
    expect(integrationCategoryLabel(t, 'crypto_exchange')).toBe('Crypto exchange');
    expect(integrationCategoryLabel(t, 'broker')).toBe('Broker');
  });

  /**
   * v2 renders only the four type codes it hard-codes, so a provider seeded
   * with any other type is absent from the one screen that can connect it.
   * Every code resolves here.
   */
  test('and an unknown one still resolves, so its provider stays connectable', () => {
    expect(integrationCategoryLabel(t, 'pension_provider')).toBe('Other');
    expect(integrationCategoryLabel(t, null)).toBe('Other');
    expect(integrationCategoryLabel(t, undefined)).toBe('Other');
  });
});

describe('the stages of a submission', () => {
  test('each names the step rather than the fact that something is happening', () => {
    for (const stage of ['account', 'upload', 'parse', 'enqueue', 'connect'] as const) {
      const text = describeCaptureStage(t, stage);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain('Loading');
    }
    expect(describeCaptureStage(t, 'upload')).toBe('Sending the file…');
  });
});
