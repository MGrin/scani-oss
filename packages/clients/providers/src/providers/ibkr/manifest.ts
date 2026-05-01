import type { IntegrationManifest } from '../../core/integration-manifest';

export const ibkrManifest: IntegrationManifest = {
  providerKey: 'ibkr',
  institutionName: 'Interactive Brokers',
  credentialFields: [
    {
      name: 'flexQueryToken',
      label: 'Flex Web Service Token',
      type: 'password',
      sensitive: true,
      required: true,
    },
    {
      name: 'flexQueryId',
      label: 'Flex Query ID',
      type: 'text',
      sensitive: false,
      required: true,
    },
  ],
  instructions: {
    steps: [
      'Log in to IBKR Client Portal → Performance & Reports → Flex Queries',
      'Under "Activity Flex Queries", click "+" to create a new query',
      'In the query editor, add these sections: "Open Positions" (check all fields) and "Cash Report" (enable "Ending Cash" or "Ending Settled Cash")',
      'Save the query and note the Query ID (shown next to the query name)',
      'Scroll down to "Flex Web Service", enable it, and click "Generate New Token"',
      'Copy the token (shown only once) and paste it below along with the Query ID',
    ],
    docsUrl: 'https://www.interactivebrokers.com/campus/ibkr-api-page/flex-web-service/',
    mobileNote: 'Use a desktop browser to access IBKR Client Portal.',
  },
  // IBKR's Flex Web Service rate-limits a token to one SendRequest per
  // minute. Pre-validating at the api router would burn the only call,
  // so the worker is the sole consumer.
  skipServerValidation: true,
};
