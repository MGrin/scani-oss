import { describe, expect, test } from 'bun:test';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { handleSaltEdgeCallback } from '../../src/integrations/saltedge-callback';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const BASE = 'https://api.example';

function signed(kind: string, data: Record<string, unknown>) {
  const rawBody = JSON.stringify({ data, meta: {} });
  const signer = createSign('RSA-SHA256');
  signer.update(`${BASE}/webhooks/saltedge/${kind}|${rawBody}`);
  return { kind, rawBody, signature: signer.sign(privateKey, 'base64') };
}

function deps(
  outcome: Awaited<ReturnType<Parameters<typeof handleSaltEdgeCallback>[1]['applyCallback']>> = {
    kind: 'applied',
    userId: 'u1',
    importNeeded: true,
  }
) {
  const applied: unknown[] = [];
  const enqueued: string[] = [];
  return {
    applied,
    enqueued,
    deps: {
      publicKeyPem: PUBLIC,
      callbackBaseUrl: BASE,
      applyCallback: async (kind: string, data: unknown) => {
        applied.push([kind, data]);
        return outcome;
      },
      enqueueImport: async (userId: string) => {
        enqueued.push(userId);
      },
    },
  };
}

const DATA = { connection_id: 'c1', customer_id: 'cust-1' };

describe('handleSaltEdgeCallback', () => {
  test('a signed success is applied and enqueues an import', async () => {
    const d = deps();
    const reply = await handleSaltEdgeCallback(signed('success', DATA), d.deps);
    expect(reply.status).toBe(200);
    expect(d.applied).toEqual([['success', { connectionId: 'c1', customerId: 'cust-1' }]]);
    expect(d.enqueued).toEqual(['u1']);
  });

  test('a forged signature is 401 and touches nothing', async () => {
    const d = deps();
    const forged = { ...signed('success', DATA), signature: signed('fail', DATA).signature };
    const reply = await handleSaltEdgeCallback(forged, d.deps);
    expect(reply.status).toBe(401);
    expect(d.applied).toEqual([]);
    expect(d.enqueued).toEqual([]);
  });

  test('an unknown kind is 404', async () => {
    const reply = await handleSaltEdgeCallback(signed('interactive', DATA), deps().deps);
    expect(reply.status).toBe(404);
  });

  test('an unreadable body is 400, never verified as empty', async () => {
    const reply = await handleSaltEdgeCallback(
      { kind: 'success', rawBody: null, signature: 'x' },
      deps().deps
    );
    expect(reply.status).toBe(400);
  });

  test('a verified callback missing its ids is acknowledged, not applied', async () => {
    const d = deps();
    const reply = await handleSaltEdgeCallback(signed('success', { connection_id: 'c1' }), d.deps);
    expect(reply.status).toBe(200);
    expect(d.applied).toEqual([]);
  });

  test('a failure on our side is 500, so Salt Edge redelivers', async () => {
    const d = deps();
    d.deps.applyCallback = async () => {
      throw new Error('db down');
    };
    const reply = await handleSaltEdgeCallback(signed('success', DATA), d.deps);
    expect(reply.status).toBe(500);
  });

  test('a fail callback applies without an import', async () => {
    const d = deps({ kind: 'applied', userId: 'u1', importNeeded: false });
    const reply = await handleSaltEdgeCallback(
      signed('fail', { ...DATA, error_class: 'InvalidCredentials' }),
      d.deps
    );
    expect(reply.status).toBe(200);
    expect(d.enqueued).toEqual([]);
  });
});
