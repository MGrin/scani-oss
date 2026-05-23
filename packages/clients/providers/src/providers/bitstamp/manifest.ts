import type { IntegrationManifest } from '../../core/integration-manifest';

export const bitstampManifest: IntegrationManifest = {
  providerKey: 'bitstamp',
  institutionName: 'Bitstamp',
  credentialFields: [
    { name: 'apiKey', label: 'API Key', type: 'text', sensitive: false, required: true },
    { name: 'apiSecret', label: 'API Secret', type: 'password', sensitive: true, required: true },
  ],
  instructions: {
    steps: [
      'Log in to Bitstamp → Profile icon → Settings → API Access',
      'Click "New API Key"',
      'Enable only "Account Balance" and "User Transactions" permissions',
      'Do NOT enable Orders, Transfers, or Withdrawals',
      'Check your email — click the activation link to finalize the key',
    ],
    docsUrl: 'https://www.bitstamp.net/api/',
    mobileNote: 'Use a desktop browser to create API keys on Bitstamp.',
  },
};
