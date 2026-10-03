import { generateKeyPairSync, type KeyObject } from 'node:crypto';

export interface ThrowawayCdpKey {
  /** Shaped like the `name` in the JSON Coinbase downloads. */
  name: string;
  /** SEC1 PEM, the EC private key form that JSON carries. */
  privateKeyPem: string;
  publicKey: KeyObject;
}

/** A P-256 key generated per call — never a real Coinbase credential. */
export function throwawayCdpKey(): ThrowawayCdpKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    name: 'organizations/00000000-test-org/apiKeys/00000000-test-key',
    privateKeyPem: privateKey.export({ type: 'sec1', format: 'pem' }).toString(),
    publicKey,
  };
}
