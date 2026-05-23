import type { IntegrationManifest } from '../../core/integration-manifest';

export const coinbaseManifest: IntegrationManifest = {
  providerKey: 'coinbase',
  institutionName: 'Coinbase',
  credentialFields: [
    { name: 'apiKey', label: 'API Key', type: 'text', sensitive: false, required: true },
    { name: 'apiSecret', label: 'API Secret', type: 'textarea', sensitive: true, required: true },
  ],
  instructions: {
    steps: [
      'Log in to Coinbase → Grid icon (top right) → Developer Platform',
      'Click "API Keys" → "Create API Key"',
      'Set permission to "View" only — do NOT enable Trade or Transfer',
      'Set signature algorithm to ECDSA',
      'Click "Create & Download" — secret downloads as a JSON file (shown only once)',
    ],
    docsUrl: 'https://help.coinbase.com/en/exchange/managing-my-account/how-to-create-an-api-key',
    mobileNote: 'Use a desktop browser to access the Coinbase Developer Platform.',
  },
};
