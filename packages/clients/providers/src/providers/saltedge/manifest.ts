import type { IntegrationManifest } from '../../core/integration-manifest';

export const saltedgeManifest: IntegrationManifest = {
  providerKey: 'saltedge',
  institutionName: 'Salt Edge',
  credentialFields: [],
  instructions: {
    steps: [
      'Continue to Salt Edge, the licensed service that connects Scani to your bank',
      'Choose your bank and sign in on its own page; Scani never sees your bank password',
      'Approve read-only access to your accounts and transactions',
      'You come back here, and the import runs in the background',
    ],
    docsUrl: 'https://www.saltedge.com/',
  },
  defaultAccountTypeCode: 'checking',
  connectFlow: 'redirect',
};
