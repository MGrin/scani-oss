import type { IntegrationManifest } from '../../core/integration-manifest';

export const binanceManifest: IntegrationManifest = {
  providerKey: 'binance',
  institutionName: 'Binance',
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
      label: 'API Secret',
      type: 'password',
      sensitive: true,
      required: true,
    },
  ],
  instructions: {
    steps: [
      'Log in to Binance → Profile icon → API Management',
      'Click "Create API" and enter a label',
      'Complete 2FA verification (email + authenticator)',
      'Keep only "Enable Reading" checked (default) — disable all trading/withdrawal permissions',
    ],
    docsUrl: 'https://www.binance.com/en/support/faq/detail/360002502072',
    mobileNote: 'You can create API keys in the Binance app: Home → More → API Management',
  },
};
