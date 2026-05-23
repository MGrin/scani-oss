import type { IntegrationManifest } from '../../core/integration-manifest';

export const kucoinManifest: IntegrationManifest = {
  providerKey: 'kucoin',
  institutionName: 'KuCoin',
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
    {
      name: 'passphrase',
      label: 'Passphrase',
      type: 'password',
      sensitive: true,
      required: true,
      hint: 'API passphrase set when creating the key — separate from your trading password',
    },
  ],
  instructions: {
    steps: [
      'Log in to KuCoin → Avatar → API Management',
      'Click "Create API" → "API Trading"',
      'Enter API name and create a passphrase (different from your passwords — save it)',
      'Enable "General" permission only — do NOT enable Trade or Transfer',
      'Complete verification (trading password + email + Google Authenticator)',
    ],
    docsUrl:
      'https://www.kucoin.com/docs/basic-info/connection-method/authentication/generating-an-api-key',
    mobileNote: 'Use a desktop browser to create API keys on KuCoin.',
  },
};
