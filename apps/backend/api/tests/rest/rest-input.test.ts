import { describe, expect, test } from 'bun:test';
import { ALL_TOOLS } from '../../src/agent-access/pipeline';
import { restInput, restParamName } from '../../src/rest/input';
import { REST_ROUTES, type RestRoute } from '../../src/rest/routes';

const UUID = '3e0a7bb6-ea08-408f-b87a-000000000001';
const OTHER = '3e0a7bb6-ea08-408f-b87a-000000000002';

function input(method: string, path: string, query = '', body?: unknown, pathParams = {}) {
  const route = REST_ROUTES.find((r) => r.method === method && r.path === path) as RestRoute;
  const tool = ALL_TOOLS.find((t) => t.name === route.tool);
  if (!tool) throw new Error(`no tool for ${path}`);
  return restInput(route, tool, new URL(`http://x/api/v1${path}${query}`), pathParams, body);
}

describe('REST input (SC-1648)', () => {
  test('a tool field is camelCase on the wire', () => {
    expect(restParamName('holding_id')).toBe('holdingId');
    expect(restParamName('holding_ids')).toBe('holdingIds');
    expect(restParamName('limit')).toBe('limit');
    expect(restParamName('accountId')).toBe('accountId');
  });

  test('query parameters reach the tool under its own names, as its own types', () => {
    expect(input('GET', '/transactions', `?holdingId=${UUID}&limit=20&offset=0`)).toEqual({
      ok: true,
      input: { holding_id: UUID, limit: 20, offset: 0 },
    });
  });

  test('a list repeats its key', () => {
    expect(input('GET', '/lots', `?holdingIds=${UUID}&holdingIds=${OTHER}`)).toEqual({
      ok: true,
      input: { holding_ids: [UUID, OTHER] },
    });
    expect(input('GET', '/lots', `?holdingIds=${UUID}`)).toEqual({
      ok: true,
      input: { holding_ids: [UUID] },
    });
  });

  test('a number that is not one is left for the tool to refuse by name', () => {
    expect(input('GET', '/transactions', '?limit=abc')).toEqual({
      ok: true,
      input: { limit: 'abc' },
    });
    expect(input('GET', '/transactions', '?limit=')).toEqual({ ok: true, input: { limit: '' } });
  });

  test('an unknown parameter is refused by name', () => {
    expect(input('GET', '/transactions', '?holding_id=x&nope=1')).toEqual({
      ok: false,
      issues: ['holding_id: unknown parameter', 'nope: unknown parameter'],
    });
  });

  test('a parameter given twice is refused unless it is a list', () => {
    expect(input('GET', '/transactions', '?limit=1&limit=2')).toEqual({
      ok: false,
      issues: ['limit: given more than once'],
    });
  });

  test('a write takes a JSON object, and the path fills its id', () => {
    const path = '/review-questions/transfers/{transactionId}/answer';
    expect(input('POST', path, '', { decision: 'left_control' }, { transactionId: UUID })).toEqual({
      ok: true,
      input: { transactionId: UUID, decision: 'left_control' },
    });
    expect(
      input(
        'POST',
        path,
        '',
        { decision: 'left_control', transactionId: UUID },
        { transactionId: UUID }
      )
    ).toEqual({ ok: true, input: { transactionId: UUID, decision: 'left_control' } });
  });

  test('a write whose only field is in the path needs no body', () => {
    const path = '/changes/{agentChangeId}/undo';
    expect(input('POST', path, '', undefined, { agentChangeId: UUID })).toEqual({
      ok: true,
      input: { agentChangeId: UUID },
    });
    expect(input('POST', path, '', {}, { agentChangeId: UUID })).toEqual({
      ok: true,
      input: { agentChangeId: UUID },
    });
    expect(input('POST', path, '', [], { agentChangeId: UUID })).toEqual({
      ok: false,
      issues: ['(body): expected a JSON object'],
    });
  });

  test('a body that is not an object, disagrees with the path or has an unknown field is refused', () => {
    const path = '/review-questions/transfers/{transactionId}/answer';
    expect(input('POST', path, '', [], { transactionId: UUID })).toEqual({
      ok: false,
      issues: ['(body): expected a JSON object'],
    });
    expect(input('POST', path, '', undefined, { transactionId: UUID })).toEqual({
      ok: false,
      issues: ['(body): expected a JSON object'],
    });
    expect(
      input('POST', path, '', { decision: 'paired', transactionId: OTHER }, { transactionId: UUID })
    ).toEqual({ ok: false, issues: ['transactionId: differs from the path'] });
    expect(input('POST', '/movements', '', { direction: 'inflow', feeQuanity: '1' })).toEqual({
      ok: false,
      issues: ['feeQuanity: unknown field'],
    });
    expect(input('POST', '/movements', '?limit=1', { direction: 'inflow' })).toEqual({
      ok: false,
      issues: ['limit: unknown parameter'],
    });
  });
});
