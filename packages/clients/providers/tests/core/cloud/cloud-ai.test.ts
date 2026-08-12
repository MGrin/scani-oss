import { describe, expect, test } from 'bun:test';
import { CloudAIProvider } from '../../../src/core/cloud/cloud-ai';
import type {
  CloudAICapabilities,
  CloudProviderClient,
} from '../../../src/core/cloud/cloud-client';

interface Call {
  op: string;
  args: unknown;
}

const FULL: CloudAICapabilities = { systemPrompt: true, pdfFileInput: true };
const NOTHING: CloudAICapabilities = { systemPrompt: false, pdfFileInput: false };

const INVOICE_RAW = { invoices: [{ vendorNameRaw: 'Neon, LLC', totalAmount: '12.96' }] };
const HOLDINGS = { holdings: [{ symbol: 'BTC', balance: '0.5' }], overallConfidence: 0.9 };

function stubClient(opts: { caps?: CloudAICapabilities; payload?: unknown; capsThrows?: Error }): {
  client: CloudProviderClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const record = (op: string, args: unknown) => {
    calls.push({ op, args });
  };
  const client = {
    async fetchAICapabilities(args: { providerKey: string }) {
      record('fetchAICapabilities', args);
      if (opts.capsThrows) throw opts.capsThrows;
      return opts.caps ?? FULL;
    },
    async parseScreenshot(args: unknown) {
      record('parseScreenshot', args);
      return opts.payload;
    },
    async parseDocumentText(args: unknown) {
      record('parseDocumentText', args);
      return opts.payload;
    },
    async completeText(args: unknown) {
      record('completeText', args);
      return 'completion';
    },
  } as unknown as CloudProviderClient;
  return { client, calls };
}

describe('CloudAIProvider — capability declarations', () => {
  test('refuses a PDF when the remote does not declare pdfFileInput, before any parse call', async () => {
    const { client, calls } = stubClient({ caps: NOTHING });
    const provider = new CloudAIProvider('openai', client);
    await expect(
      provider.parseScreenshot({ imageBase64: 'JVBERi0=', mimeType: 'application/pdf' })
    ).rejects.toThrow(/PDF input not supported/);
    // The point of declaring is not paying for the refusal: the upstream
    // parse must never have been attempted.
    expect(calls.map((c) => c.op)).toEqual(['fetchAICapabilities']);
  });

  test('sends a PDF when the remote declares pdfFileInput', async () => {
    const { client, calls } = stubClient({ payload: { raw: INVOICE_RAW } });
    const provider = new CloudAIProvider('openai', client);
    await provider.parseScreenshot({
      imageBase64: 'JVBERi0=',
      mimeType: 'application/pdf',
      systemPrompt: 'INVOICE SCHEMA',
    });
    expect(calls.map((c) => c.op)).toEqual(['fetchAICapabilities', 'parseScreenshot']);
  });

  test('refuses a systemPrompt the remote would overwrite, on both parse methods', async () => {
    const { client, calls } = stubClient({ caps: NOTHING });
    const provider = new CloudAIProvider('openai', client);
    await expect(
      provider.parseScreenshot({
        imageBase64: 'aW1n',
        mimeType: 'image/png',
        systemPrompt: 'INVOICE SCHEMA',
      })
    ).rejects.toThrow(/systemPrompt not supported/);
    await expect(provider.parseDocumentText('text', undefined, 'INVOICE SCHEMA')).rejects.toThrow(
      /systemPrompt not supported/
    );
    expect(calls.every((c) => c.op === 'fetchAICapabilities')).toBe(true);
  });

  test('does not probe capabilities for the plain holdings path', async () => {
    const { client, calls } = stubClient({ payload: { portfolio: HOLDINGS } });
    const provider = new CloudAIProvider('openai', client);
    await provider.parseScreenshot({ imageBase64: 'aW1n', mimeType: 'image/png' });
    await provider.parseDocumentText('csv,header');
    expect(calls.map((c) => c.op)).toEqual(['parseScreenshot', 'parseDocumentText']);
  });

  test('probes once and reuses the answer across calls', async () => {
    const { client, calls } = stubClient({ payload: { raw: INVOICE_RAW } });
    const provider = new CloudAIProvider('openai', client);
    await provider.parseDocumentText('a', undefined, 'INVOICE SCHEMA');
    await provider.parseDocumentText('b', undefined, 'INVOICE SCHEMA');
    expect(calls.filter((c) => c.op === 'fetchAICapabilities')).toHaveLength(1);
  });

  test('a failed probe is not cached as "unsupported"', async () => {
    const { client } = stubClient({ capsThrows: new Error('data-provider unreachable') });
    const provider = new CloudAIProvider('openai', client);
    await expect(provider.parseDocumentText('a', undefined, 'P')).rejects.toThrow(
      /data-provider unreachable/
    );
    await expect(provider.parseDocumentText('a', undefined, 'P')).rejects.toThrow(
      /data-provider unreachable/
    );
  });
});

describe('CloudAIProvider — response unwrapping', () => {
  test('a systemPrompt response reaches the caller in the model own shape', async () => {
    const { client, calls } = stubClient({ payload: { raw: INVOICE_RAW, metadata: {} } });
    const provider = new CloudAIProvider('openai', client);
    const result = await provider.parseDocumentText(
      'invoice markdown',
      undefined,
      'INVOICE SCHEMA'
    );
    expect(result.data).toEqual(INVOICE_RAW);
    // Argument position, same reason as the direct provider's regression
    // test: the prompt in the wrong slot fails silently.
    expect(calls[1]?.args).toMatchObject({
      text: 'invoice markdown',
      systemPrompt: 'INVOICE SCHEMA',
    });
  });

  test('a holdings response is unwrapped to the portfolio the direct provider would return', async () => {
    const { client } = stubClient({ payload: { portfolio: HOLDINGS, metadata: {} } });
    const provider = new CloudAIProvider('openai', client);
    const result = await provider.parseScreenshot({ imageBase64: 'aW1n', mimeType: 'image/png' });
    expect(result.data).toEqual(HOLDINGS);
  });

  test('throws when a remote that declared systemPrompt support normalizes anyway', async () => {
    const { client } = stubClient({ payload: { portfolio: { holdings: [] }, metadata: {} } });
    const provider = new CloudAIProvider('openai', client);
    await expect(provider.parseDocumentText('inv', undefined, 'INVOICE SCHEMA')).rejects.toThrow(
      /holdings-shaped response/
    );
  });
});
