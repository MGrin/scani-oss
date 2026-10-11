import { describe, expect, test } from 'bun:test';
import { renderScalarHtml } from '@scani/config/api-reference';
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
    // 8 since SC-1277 stopped publishing the 9 internal procedures below.
    // 17 since SC-587 removed the `pricing.*` (5) and `ai.*` (4) routers.
    // The 26 - 9 = 17 is worth keeping as arithmetic rather than a new
    // number: it is the independent check that the deletion removed
    // exactly the nine procedures the PR says it did.
    // (26 since SC-208 added `storage.readObject` + `storage.writeObject`;
    // 24 since SC-167 added `storage.objectExists`.)
    expect(everyOperation().length).toBe(8);
  });

  // SC-1277. `email.send` and the eight `storage.*` procedures are
  // `internalProcedure`: every customer key gets 403 FORBIDDEN (SC-585). A
  // reference that lists them promises a Tier 2 customer calls they can never
  // make, which is worse than not documenting them.
  test('publishes no internal procedure', () => {
    const internal = Object.keys(paths).filter(
      (path) => path.startsWith('/trpc/storage.') || path.startsWith('/trpc/email.')
    );
    expect(internal).toEqual([]);
  });

  test('describes only what a customer key can call', () => {
    const description = (doc.info as { description: string }).description;
    for (const gone of ['pricing', 'AI', 'storage', 'email']) {
      expect(description, `description still names ${gone}`).not.toContain(gone);
    }
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

  // A `pricing.convertRate documents the rate it actually returns` test stood
  // here until SC-587 deleted that router. It was the named instance of the
  // generic assertion above, which runs over `everyOperation()` and survives.
  // Not replaced with the same assertion pointed at another procedure: that
  // would be a new check wearing the old one's evidence.

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

// SC-1353: the docs page runs on the origin that holds the scani-cloud session
// cookie, and it loaded `@scalar/api-reference` from jsDelivr with no version
// and no integrity. Whatever that URL served next would run with the cookie.
describe('the API reference page loads a pinned, integrity-checked script (SC-1353)', () => {
  const html = renderScalarHtml('/openapi.json', 'Scani Cloud API — Reference');
  const tags = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/g)];

  test('every external script names an exact version and carries an integrity hash', () => {
    expect(tags.length).toBeGreaterThan(0);
    for (const [tag, src] of tags) {
      expect(src).toMatch(/@\d+\.\d+\.\d+\//);
      expect(tag).toMatch(/\bintegrity="sha384-[A-Za-z0-9+/=]{64}"/);
      expect(tag).toContain('crossorigin="anonymous"');
    }
  });

  test('the spec URL is still wired (control)', () => {
    expect(html).toContain('data-url="/openapi.json"');
  });
});
