import type { IntegrationManifest } from '../../core/integration-manifest';

export const coinbaseManifest: IntegrationManifest = {
  providerKey: 'coinbase',
  institutionName: 'Coinbase',
  credentialFields: [
    {
      name: 'apiKey',
      label: 'API Key Name',
      type: 'text',
      sensitive: false,
      required: true,
      placeholder: 'organizations/…/apiKeys/…',
    },
    {
      name: 'apiSecret',
      label: 'Private Key',
      type: 'textarea',
      sensitive: true,
      required: true,
      placeholder: 'The privateKey value from the downloaded JSON',
    },
  ],
  instructions: {
    steps: [
      'Log in to Coinbase → Grid icon (top right) → Developer Platform',
      'Click "API Keys" → "Create API Key"',
      'Set permission to "View" only — do NOT enable Trade or Transfer',
      'Set signature algorithm to ECDSA — an Ed25519 key cannot read your Coinbase accounts',
      'Click "Create & Download" — the key downloads as a JSON file (shown only once)',
      'From that JSON, paste the "name" value (organizations/…/apiKeys/…) into "API Key Name"',
      'Paste the whole "privateKey" value, from its BEGIN line to its END line, into "Private Key"',
    ],
    docsUrl:
      'https://docs.cdp.coinbase.com/coinbase-app/authentication-authorization/api-key-authentication',
    mobileNote: 'Use a desktop browser to access the Coinbase Developer Platform.',
  },
};
