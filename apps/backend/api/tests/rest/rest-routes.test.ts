import { describe, expect, test } from 'bun:test';
import { ALL_TOOLS } from '../../src/agent-access/pipeline';
import { restParamName } from '../../src/rest/input';
import { REST_EXCLUDED_TOOLS, REST_NOT_IN_V1, REST_ROUTES } from '../../src/rest/routes';

// SC-1648. The route table is the whole REST surface, so these are the rules
// that keep it one tool per route and nothing a tool does not do.

const tool = (name: string) => ALL_TOOLS.find((t) => t.name === name);
const properties = (name: string) =>
  Object.keys((tool(name)?.inputSchema.properties ?? {}) as Record<string, unknown>);

describe('the REST route table (SC-1648)', () => {
  test('every route names a real tool', () => {
    expect(REST_ROUTES.filter((r) => !tool(r.tool)).map((r) => r.tool)).toEqual([]);
  });

  test('every tool is routed exactly once, or is excluded with a reason', () => {
    for (const { name } of ALL_TOOLS) {
      const routed = REST_ROUTES.filter((r) => r.tool === name).length;
      const excluded = name in REST_EXCLUDED_TOOLS;
      expect({ name, routed, excluded }).toEqual({ name, routed: excluded ? 0 : 1, excluded });
    }
    expect(Object.keys(REST_EXCLUDED_TOOLS).filter((name) => !tool(name))).toEqual([]);
    for (const reason of Object.values(REST_EXCLUDED_TOOLS))
      expect(reason.length).toBeGreaterThan(10);
  });

  test('13 reads and 5 writes, and no two share a method and path', () => {
    expect(REST_ROUTES.filter((r) => r.method === 'GET')).toHaveLength(13);
    expect(REST_ROUTES.filter((r) => r.method === 'POST')).toHaveLength(5);
    const keys = REST_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('a GET never reaches a tool that writes, and a POST always does', () => {
    for (const route of REST_ROUTES) {
      expect({ route: route.path, writes: Boolean(tool(route.tool)?.writes) }).toEqual({
        route: route.path,
        writes: route.method === 'POST',
      });
    }
  });

  test('a path parameter is an input field of its tool', () => {
    for (const route of REST_ROUTES) {
      for (const [, name] of route.path.matchAll(/\{(\w+)\}/g)) {
        expect(properties(route.tool)).toContain(name as string);
      }
    }
  });

  test('a write tool takes camelCase fields, so a body needs no renaming', () => {
    for (const route of REST_ROUTES.filter((r) => r.method === 'POST')) {
      for (const key of properties(route.tool)) expect(restParamName(key)).toBe(key);
    }
  });

  test('the omissions the reference lists are the five the spec names', () => {
    expect(REST_NOT_IN_V1.map((row) => row.what)).toEqual([
      'File imports',
      'Full export',
      'Price history and per-account balance history',
      'Token management',
      'Editing or deleting a row',
    ]);
  });
});
