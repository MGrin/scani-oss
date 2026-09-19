import { describe, expect, test } from 'bun:test';
import { createSign, generateKeyPairSync } from 'node:crypto';
import {
  parseSaltEdgeCallback,
  verifySaltEdgeCallback,
} from '../../src/providers/saltedge/callback';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const URL = 'https://api.example/webhooks/saltedge/success';
const BODY = JSON.stringify({ data: { connection_id: 'c1', customer_id: 'u1' }, meta: {} });

function sign(url: string, body: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(`${url}|${body}`);
  return signer.sign(privateKey, 'base64');
}

describe('verifySaltEdgeCallback', () => {
  test('accepts a signature over callback_url|raw_body', () => {
    expect(verifySaltEdgeCallback(URL, BODY, sign(URL, BODY), publicPem)).toBe(true);
  });

  test('refuses a body that differs by one byte', () => {
    expect(verifySaltEdgeCallback(URL, `${BODY} `, sign(URL, BODY), publicPem)).toBe(false);
  });

  test('refuses the same body signed for another url', () => {
    const other = 'https://api.example/webhooks/saltedge/destroy';
    expect(verifySaltEdgeCallback(URL, BODY, sign(other, BODY), publicPem)).toBe(false);
  });

  test('refuses a missing or garbage signature rather than throwing', () => {
    expect(verifySaltEdgeCallback(URL, BODY, '', publicPem)).toBe(false);
    expect(verifySaltEdgeCallback(URL, BODY, 'not-base64!!', publicPem)).toBe(false);
  });
});

describe('parseSaltEdgeCallback', () => {
  test('reads the connection, the customer and a failure class', () => {
    const body = JSON.stringify({
      data: { connection_id: 'c1', customer_id: 'u1', error_class: 'InvalidCredentials' },
    });
    expect(parseSaltEdgeCallback(body)).toEqual({
      connectionId: 'c1',
      customerId: 'u1',
      errorClass: 'InvalidCredentials',
    });
  });

  test('a consent callback carries its reason as the error class', () => {
    const body = JSON.stringify({
      data: { connection_id: 'c1', customer_id: 'u1', reason: 'expired' },
    });
    expect(parseSaltEdgeCallback(body)?.errorClass).toBe('expired');
  });

  test('ids arriving as numbers are read as strings', () => {
    const body = JSON.stringify({ data: { connection_id: 11, customer_id: 22 } });
    expect(parseSaltEdgeCallback(body)).toEqual({ connectionId: '11', customerId: '22' });
  });

  test('malformed or incomplete payloads are null', () => {
    expect(parseSaltEdgeCallback('not json')).toBeNull();
    expect(parseSaltEdgeCallback(JSON.stringify({ data: { connection_id: 'c1' } }))).toBeNull();
  });
});
