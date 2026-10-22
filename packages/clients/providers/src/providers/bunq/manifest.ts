import type { IntegrationManifest } from '../../core/integration-manifest';

export const bunqManifest: IntegrationManifest = {
  providerKey: 'bunq',
  institutionName: 'bunq',
  defaultAccountTypeCode: 'checking',
  // bunq's terms: "OAuth is the obligatory authentication method for public
  // projects", and a personal key is for the customer's own software
  // (doc.bunq.com, read 2026-10-12; quoted on SC-1729).
  selfHostedOnly: true,
  credentialCanMoveMoney: true,
  // help.bunq.com: statements export as "PDF, CSV or MT940"; bunq offers no
  // CAMT.053. Scani imports the last two (read 2026-10-11).
  statementExportFormats: ['MT940', 'CSV'],
  credentialFields: [
    {
      name: 'apiKey',
      label: 'API key',
      type: 'password',
      sensitive: true,
      required: true,
      hint: 'A personal API key from the bunq app',
    },
  ],
  instructions: {
    steps: [
      'Open the bunq app',
      'Go to Profile → Security & Settings → Developers → API keys',
      'Add an API key and copy it',
      'Connect from the server Scani runs on: bunq ties a key to the address it was first used from',
    ],
    docsUrl: 'https://doc.bunq.com/basics/authentication/api-keys',
  },
};
