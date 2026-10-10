/**
 * The whole REST surface (SC-1648): each route is one agent tool under an HTTP
 * method and path. A `{name}` segment fills the tool's input field of that name.
 * The OpenAPI document and the docs page are generated from, and checked
 * against, this table.
 */

export const REST_BASE = '/api/v1';

/** Every `error.code` a failed request can carry. */
export const REST_ERROR_CODES = [
  'unauthenticated',
  'rate_limited',
  'agent_access_off',
  'read_only_token',
  'forbidden',
  'invalid_input',
  'not_found',
  'method_not_allowed',
  'conflict',
  'internal',
] as const;

export interface RestRoute {
  method: 'GET' | 'POST';
  path: string;
  tool: string;
}

export const REST_ROUTES: readonly RestRoute[] = [
  { method: 'GET', path: '/portfolio/summary', tool: 'get_portfolio_summary' },
  { method: 'GET', path: '/portfolio/allocation', tool: 'get_allocation' },
  { method: 'GET', path: '/portfolio/returns', tool: 'get_returns' },
  { method: 'GET', path: '/portfolio/net-worth', tool: 'get_net_worth_series' },
  { method: 'GET', path: '/portfolio/realized-gains', tool: 'get_realized_gains' },
  { method: 'GET', path: '/portfolio/data-quality', tool: 'get_data_quality' },
  { method: 'GET', path: '/accounts', tool: 'list_accounts' },
  { method: 'GET', path: '/holdings', tool: 'list_holdings' },
  { method: 'GET', path: '/lots', tool: 'get_open_lots' },
  { method: 'GET', path: '/transactions', tool: 'list_transactions' },
  { method: 'GET', path: '/tokens', tool: 'search_tokens' },
  { method: 'GET', path: '/review-questions', tool: 'list_review_questions' },
  { method: 'GET', path: '/changes', tool: 'list_agent_changes' },
  { method: 'POST', path: '/movements', tool: 'record_movement' },
  { method: 'POST', path: '/holdings', tool: 'create_holdings' },
  {
    method: 'POST',
    path: '/review-questions/transfers/{transactionId}/answer',
    tool: 'answer_transfer_review',
  },
  {
    method: 'POST',
    path: '/review-questions/balance-gaps/{observationId}/answer',
    tool: 'answer_balance_gap',
  },
  { method: 'POST', path: '/changes/{agentChangeId}/undo', tool: 'undo_agent_change' },
];

/** Tools `/mcp` offers and `/api/v1` does not, each with the reason. */
export const REST_EXCLUDED_TOOLS: Readonly<Record<string, string>> = {
  get_portfolio_analysis:
    'Advice worded for an AI model. Its wording changes often, so it cannot be a frozen contract.',
  plan_rebalance:
    'Advice worded for an AI model. Its wording changes often, so it cannot be a frozen contract.',
  get_suggestions:
    'Advice worded for an AI model. Its wording changes often, so it cannot be a frozen contract.',
};

/** What a reader may expect of a finance API and v1 does not do. */
export const REST_NOT_IN_V1: readonly { what: string; why: string }[] = [
  {
    what: 'File imports',
    why: 'An upload, a column mapping and a background job; import is being reshaped.',
  },
  {
    what: 'Full export',
    why: 'The backup file is built by a separate change; a route follows it.',
  },
  {
    what: 'Price history and per-account balance history',
    why: 'No tool reads them yet. Each needs a new read before it can be a route.',
  },
  { what: 'Token management', why: 'A token cannot create or revoke tokens. Use Settings.' },
  {
    what: 'Editing or deleting a row',
    why: 'There is no PATCH or DELETE. To take a change back, undo it: POST /changes/{agentChangeId}/undo.',
  },
];
