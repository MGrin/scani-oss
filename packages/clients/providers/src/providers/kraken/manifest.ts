import type { IntegrationManifest } from '../../core/integration-manifest';

export const krakenManifest: IntegrationManifest = {
  providerKey: 'kraken',
  institutionName: 'Kraken',
  credentialFields: [
    { name: 'apiKey', label: 'API Key', type: 'text', sensitive: false, required: true },
    { name: 'apiSecret', label: 'API Secret', type: 'password', sensitive: true, required: true },
  ],
  instructions: {
    steps: [
      'Log in to Kraken Pro → Profile icon → Settings → API tab',
      'Click "Create API key" and enter a name',
      'Enable only "Query Funds" and "Query Orders & Trades"',
      'Do NOT enable "Modify Orders" or withdrawal permissions',
    ],
    docsUrl: 'https://support.kraken.com/articles/360000919966-how-to-create-an-api-key',
    mobileNote: 'Use a desktop browser to access Kraken Pro settings.',
  },
};
