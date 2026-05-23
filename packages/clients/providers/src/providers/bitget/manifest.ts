import type { IntegrationManifest } from '../../core/integration-manifest';

export const bitgetManifest: IntegrationManifest = {
  providerKey: 'bitget',
  institutionName: 'Bitget',
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
      hint: 'The passphrase you set when creating the API key',
    },
  ],
  instructions: {
    steps: [
      'Log in to Bitget → Account icon → API Keys',
      'Click "Create API Key" → "System-generated"',
      'Enter a name and create a passphrase (save it — cannot be recovered if lost)',
      'Set permissions to "Read-Only"',
      'Copy API Key, Secret Key, and Passphrase',
    ],
    docsUrl: 'https://www.bitget.com/support/articles/360038968251-API-Creation-Guide',
    mobileNote: 'Use a desktop browser to create API keys on Bitget.',
  },
};
