import type { IntegrationManifest } from '../../core/integration-manifest';

export const huobiManifest: IntegrationManifest = {
  providerKey: 'huobi',
  institutionName: 'Huobi',
  credentialFields: [
    {
      name: 'apiKey',
      label: 'Access Key',
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
  ],
  instructions: {
    steps: [
      'Log in to HTX (Huobi) → Account icon → API Management',
      'Click "Create API Key" and enter a label',
      'Check "Read" permission only — do NOT enable Trade or Withdraw',
      'Complete SMS + Email + Google Authenticator verification',
      'Copy API Key and Secret Key (secret shown only once)',
    ],
    docsUrl: 'https://www.htx.com/support/360000203002',
    mobileNote: 'Use a desktop browser to create API keys on HTX.',
  },
};
