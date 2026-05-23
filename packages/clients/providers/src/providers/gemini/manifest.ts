import type { IntegrationManifest } from '../../core/integration-manifest';

export const geminiManifest: IntegrationManifest = {
  providerKey: 'gemini',
  institutionName: 'Gemini',
  credentialFields: [
    { name: 'apiKey', label: 'API Key', type: 'text', sensitive: false, required: true },
    { name: 'apiSecret', label: 'API Secret', type: 'password', sensitive: true, required: true },
  ],
  instructions: {
    steps: [
      'Log in to Gemini → Menu → Account → API',
      'Click "Create a new API Key" and enter your 2FA code',
      'Set the role to "Auditor" for read-only access',
      'Choose IP restriction: "Unrestricted" or "Trusted IPs Only"',
      'Copy API Key and Secret',
    ],
    docsUrl: 'https://support.gemini.com/hc/en-us/articles/360031080191-How-do-I-create-an-API-key',
    mobileNote: 'Possible on mobile web, but desktop browser is recommended.',
  },
};
