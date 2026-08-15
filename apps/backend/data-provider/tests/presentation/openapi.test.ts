import { describe, expect, test } from 'bun:test';
import { buildOpenApiDocument } from '../../src/presentation/openapi';
import { appRouter } from '../../src/presentation/router';

/**
 * The published spec is the Cloud API's shopfront: `cloud.scani.xyz`
 * links it as the API reference and the landing sells "type-safe
 * endpoints" off it. Every operation shipped an empty `200` schema for
 * as long as the routers declared `.output(z.unknown())`, because
 * `trpc-openapi` derives the response schema from the output parser and
 * cannot see a TypeScript return annotation (SC-108).
 */

interface Operation {
  responses?: Record<string, { content?: Record<string, { schema?: Record<string, unknown> }> }>;
}

const doc = buildOpenApiDocument(appRouter, {
  baseUrl: 'https://api.cloud.scani.xyz',
  version: '0.0.0-test',
});

const paths = doc.paths as Record<string, Record<string, Operation>>;

function everyOperation(): Array<{ id: string; operation: Operation }> {
  const out: Array<{ id: string; operation: Operation }> = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      out.push({ id: `${method.toUpperCase()} ${path}`, operation });
    }
  }
  return out;
}

function successSchema(operation: Operation): Record<string, unknown> | undefined {
  return operation.responses?.['200']?.content?.['application/json']?.schema;
}

describe('OpenAPI document', () => {
  test('exposes every operation the routers annotate', () => {
    // 24. The private tree counts 25: it registers a `waitlist` router that
    // this repo does not, and `presentation/router.ts` is pinned to private's
    // version on every sync, so the extra operation never arrives here.
    expect(everyOperation().length).toBe(24);
  });

  test('no operation publishes an empty response schema', () => {
    const empty = everyOperation()
      .filter(({ operation }) => {
        const schema = successSchema(operation);
        return !schema || Object.keys(schema).length === 0;
      })
      .map(({ id }) => id);
    expect(empty).toEqual([]);
  });

  test('success bodies are described inside tRPC’s result envelope', () => {
    // The server has no REST adapter, so the body really is
    // `{"result":{"data":…}}`. A schema describing the bare data would
    // send every generated client looking one level too high.
    for (const { id, operation } of everyOperation()) {
      const schema = successSchema(operation) as {
        properties?: { result?: { properties?: { data?: Record<string, unknown> } } };
      };
      const data = schema.properties?.result?.properties?.data;
      expect(data, `${id} should wrap its payload in result.data`).toBeDefined();
      expect(Object.keys(data ?? {}).length, `${id} data schema is empty`).toBeGreaterThan(0);
    }
  });

  test('pricing.convertRate documents the rate it actually returns', () => {
    const schema = successSchema(paths['/trpc/pricing.convertRate']?.get as Operation) as {
      properties: { result: { properties: { data: { properties: Record<string, unknown> } } } };
    };
    expect(schema.properties.result.properties.data.properties).toHaveProperty('rate');
  });

  test('the error response matches the envelope tRPC actually sends', () => {
    const components = doc.components as {
      responses: {
        error: { content: Record<string, { schema: { properties: Record<string, unknown> } }> };
      };
    };
    const schema = components.responses.error.content['application/json']?.schema;
    expect(schema?.properties).toHaveProperty('error');
  });
});
