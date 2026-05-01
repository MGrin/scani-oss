import type { IntegrationManifest } from '../../core/integration-manifest';

export const bybitManifest: IntegrationManifest = {
  providerKey: 'bybit',
  institutionName: 'Bybit',
  credentialFields: [
    { name: 'apiKey', label: 'API Key', type: 'text', sensitive: false, required: true },
    { name: 'apiSecret', label: 'API Secret', type: 'password', sensitive: true, required: true },
  ],
  instructions: {
    steps: [
      'Log in to Bybit → Profile icon → API',
      'Click "Create New Key" → "System-generated API Key"',
      'Set API Key Permissions to "Read-Only"',
      'Complete Google Authenticator verification',
      'Copy API Key and Secret (shown only once)',
    ],
    docsUrl: 'https://www.bybit.com/en/help-center/article/How-to-create-your-API-key',
    mobileNote: 'Use a desktop browser to create API keys on Bybit.',
  },
};
