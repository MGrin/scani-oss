import { describe, expect, it } from 'bun:test';
import { buildOpenApiDoc } from '../../src/openapi/build-doc';
import { mobileContractRouter } from '../../src/openapi/mobile-contract-router';
import { appRouter } from '../../src/presentation/router';

describe('buildOpenApiDoc', () => {
  const doc = buildOpenApiDoc(mobileContractRouter);

  it('documents all expected contract paths', () => {
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        '/trpc/system.ping',
        '/trpc/mobile.accounts',
        '/trpc/mobile.holdings',
        '/trpc/mobile.groups',
        '/trpc/mobile.vaults',
        '/trpc/mobile.updateAccount',
        '/trpc/mobile.deleteAccount',
        '/trpc/mobile.createHolding',
        '/trpc/mobile.updateHolding',
        '/trpc/mobile.deleteHolding',
        '/trpc/mobile.createGroup',
        '/trpc/mobile.updateGroup',
        '/trpc/mobile.deleteGroup',
        '/trpc/mobile.createVault',
        '/trpc/mobile.updateVault',
        '/trpc/mobile.deleteVault',
      ])
    );
  });

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

  it('documents mobile.accounts 200 response as an array of objects with id and name', () => {
    // biome-ignore lint/suspicious/noExplicitAny: traversing a loosely-typed OpenAPI doc
    const op = (doc.paths as any)['/trpc/mobile.accounts'];
    expect(op).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: same
    const schema = op.get.responses['200'].content['application/json'].schema as any;
    const dataSchema = schema.properties.result.properties.data;
    expect(dataSchema.type).toBe('array');
    expect(dataSchema.items.properties.id).toBeDefined();
    expect(dataSchema.items.properties.name).toBeDefined();
  });

  it('documents mobile.createGroup request body with name and color fields', () => {
    // biome-ignore lint/suspicious/noExplicitAny: traversing a loosely-typed OpenAPI doc
    const op = (doc.paths as any)['/trpc/mobile.createGroup'];
    expect(op).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: same
    const bodySchema = op.post.requestBody.content['application/json'].schema as any;
    expect(bodySchema.properties.name).toBeDefined();
    expect(bodySchema.properties.color).toBeDefined();
  });

  it('documents mobile.updateHolding request body with id and data fields', () => {
    // biome-ignore lint/suspicious/noExplicitAny: traversing a loosely-typed OpenAPI doc
    const op = (doc.paths as any)['/trpc/mobile.updateHolding'];
    expect(op).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: same
    const bodySchema = op.post.requestBody.content['application/json'].schema as any;
    expect(bodySchema.properties.id).toBeDefined();
    expect(bodySchema.properties.data).toBeDefined();
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
