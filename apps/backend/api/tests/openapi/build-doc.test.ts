import { describe, expect, it } from 'bun:test';
import { buildOpenApiDoc } from '../../src/openapi/build-doc';
import { mobileContractRouter } from '../../src/openapi/mobile-contract-router';
import { appRouter } from '../../src/presentation/router';

describe('buildOpenApiDoc', () => {
  const doc = buildOpenApiDoc(mobileContractRouter);

  it('documents system.ping with a typed result.data response', () => {
    // biome-ignore lint/suspicious/noExplicitAny: traversing a loosely-typed OpenAPI doc
    const op = (doc.paths as any)['/trpc/system.ping'];
    expect(op).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: same
    const schema = op.get.responses['200'].content['application/json'].schema as any;
    const dataProps = schema.properties.result.properties.data.properties;
    expect(dataProps.status).toBeDefined();
    expect(dataProps.service).toBeDefined();
  });

  it('only documents procedures the real appRouter actually serves (drift guard)', () => {
    // biome-ignore lint/suspicious/noExplicitAny: reading tRPC internal procedure map for a guardrail
    const served = (appRouter as any)._def.procedures as Record<string, unknown>;
    for (const path of Object.keys(doc.paths)) {
      const proc = path.replace(/^\/trpc\//, '');
      expect(served[proc]).toBeDefined();
    }
  });
});
