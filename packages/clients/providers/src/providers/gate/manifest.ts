import type { IntegrationManifest } from '../../core/integration-manifest';

export const gateManifest: IntegrationManifest = {
  providerKey: 'gate',
  institutionName: 'Gate.io',
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
      'Log in to Gate.io → Profile icon → API Management',
      'Click "Create API Key" and enter a name',
      'Under API Permissions, select "Enable Reading" only',
      'Do NOT enable Trading or Withdrawals',
      'Copy API Key and Secret Key (secret shown only once)',
    ],
    docsUrl: 'https://www.gate.com/help/guide/common/17521/how-to-utilize-api',
    mobileNote: 'Use a desktop browser to create API keys on Gate.io.',
  },
};
