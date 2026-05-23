import type { IntegrationManifest } from '../../core/integration-manifest';

export const okxManifest: IntegrationManifest = {
  providerKey: 'okx',
  institutionName: 'OKX',
  credentialFields: [
    {
      name: 'apiKey',
      label: 'API Key',
      type: 'text',
      sensitive: false,
      required: true,
    },
    {
      name: 'apiSecret',
      label: 'Secret Key',
      type: 'password',
      sensitive: true,
      required: true,
    },
    {
      name: 'passphrase',
      label: 'Passphrase',
      type: 'password',
      sensitive: true,
      required: true,
      hint: 'The passphrase you set when creating the API key — distinct from your account password',
    },
  ],
  instructions: {
    steps: [
      'Log in to OKX on desktop → User icon → API',
      'Click "Create V5 API Key"',
      'Enter a key name and create a passphrase (save it — cannot be recovered)',
      'Set permissions to "Read" only',
      'Copy API Key, Secret Key, and Passphrase',
    ],
    docsUrl: 'https://www.okx.com/docs-v5/en/',
    mobileNote: 'OKX requires a desktop/PC to create API keys — not available on mobile.',
  },
};
