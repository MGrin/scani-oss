import type { IntegrationManifest } from '../../core/integration-manifest';

export const airwallexManifest: IntegrationManifest = {
  providerKey: 'airwallex',
  institutionName: 'Airwallex',
  defaultAccountTypeCode: 'savings',
  credentialFields: [
    {
      name: 'clientId',
      label: 'Client ID',
      type: 'text',
      sensitive: false,
      required: true,
      hint: 'Unique Client ID from the Airwallex web app (Developer → API keys)',
    },
    {
      name: 'apiKey',
      label: 'API Key',
      type: 'password',
      sensitive: true,
      required: true,
      hint: 'API key paired with the Client ID; shown only once at creation',
    },
  ],
  instructions: {
    steps: [
      'Log in to your Airwallex account at airwallex.com',
      'Open the Developer section and go to API keys',
      'Create a new API key — note the Client ID and the API key value',
      'Copy both and store the API key securely (it is shown only once)',
    ],
    docsUrl: 'https://www.airwallex.com/docs/developer-tools/api/manage-api-keys',
    mobileNote: 'Use a desktop browser. Requires API access enabled on your Airwallex account.',
  },
};
