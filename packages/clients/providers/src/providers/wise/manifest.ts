import type { IntegrationManifest } from '../../core/integration-manifest';

export const wiseManifest: IntegrationManifest = {
  providerKey: 'wise',
  institutionName: 'Wise',
  credentialFields: [
    {
      name: 'apiToken',
      label: 'API Token',
      type: 'password',
      sensitive: true,
      required: true,
      hint: 'Personal API token from your Wise Business account',
    },
  ],
  instructions: {
    steps: [
      'Log in to your Wise Business account at wise.com',
      'Go to Your Account → Integrations and Tools → API tokens',
      'Click "Add new token" and complete 2-step verification',
      'Copy and securely store the token (shown only once)',
    ],
    docsUrl: 'https://docs.wise.com/guides/developer/auth-and-security/personal-api-token',
    mobileNote: 'Use a desktop browser. Requires a Wise Business account (not personal).',
  },
};
