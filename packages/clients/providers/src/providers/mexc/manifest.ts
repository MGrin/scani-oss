import type { IntegrationManifest } from '../../core/integration-manifest';

export const mexcManifest: IntegrationManifest = {
  providerKey: 'mexc',
  institutionName: 'MEXC',
  credentialFields: [
    { name: 'apiKey', label: 'API Key', type: 'text', sensitive: false, required: true },
    { name: 'apiSecret', label: 'API Secret', type: 'password', sensitive: true, required: true },
  ],
  instructions: {
    steps: [
      'Log in to MEXC → Profile icon → API Management',
      'Click "Create New API Key" and enter a label',
      'Enable only read/view permissions under Spot',
      'Do NOT enable Withdraw or Transfer',
      'Note: keys without IP binding expire after 90 days',
    ],
    docsUrl: 'https://www.mexc.com/support/articles/360055933652',
    mobileNote: 'Use a desktop browser to create API keys on MEXC.',
  },
};
