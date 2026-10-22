import type { IntegrationManifest } from '../../core/integration-manifest';

export const investecManifest: IntegrationManifest = {
  providerKey: 'investec',
  institutionName: 'Investec',
  defaultAccountTypeCode: 'checking',
  // Investec: an integration "used for yourself or your business operations"
  // uses your own credentials; a platform that "serves many clients" needs "A
  // formal third-party onboarding process with Investec"
  // (developer.investec.com/third-parties, read 2026-10-12; quoted on SC-1731).
  selfHostedOnly: true,
  // The connect step refuses a key whose scopes include transfers or
  // beneficiary payments, so the key Scani holds can only read.
  credentialCanMoveMoney: false,
  credentialFields: [
    {
      name: 'clientId',
      label: 'Client ID',
      type: 'password',
      sensitive: true,
      required: true,
      hint: 'Investec Online → Manage → Investec Developer → Individual Connections',
    },
    {
      name: 'clientSecret',
      label: 'Secret',
      type: 'password',
      sensitive: true,
      required: true,
    },
    {
      name: 'apiKey',
      label: 'API key',
      type: 'password',
      sensitive: true,
      required: true,
      hint: 'Give it only account name and number, balance and transaction access',
    },
  ],
  instructions: {
    steps: [
      'In Investec Online, go to Manage → Investec Developer and click Enrol',
      'Open Individual Connections and copy your client ID and secret',
      'Create a new API key with only "Your account name and number", "Your account balance" and "Your transactions"',
    ],
    note: 'Scani refuses a key that can also transfer or pay.',
    docsUrl: 'https://developer.investec.com/individuals',
  },
};
