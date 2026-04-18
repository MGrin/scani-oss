import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/types';
import { b64urlDecode } from './b64';
import { getAuthConfig } from './config';

export async function beginPasskeyLogin(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpId, credentialIdB64 } = getAuthConfig();
  return generateAuthenticationOptions({
    rpID: rpId,
    allowCredentials: [{ id: credentialIdB64 }],
    userVerification: 'preferred',
  });
}

export async function verifyPasskeyLogin(
  response: AuthenticationResponseJSON,
  expectedChallenge: string
): Promise<boolean> {
  const { rpId, origin, credentialIdB64, publicKeyB64 } = getAuthConfig();
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpId,
    credential: {
      id: credentialIdB64,
      publicKey: b64urlDecode(publicKeyB64),
      counter: 0,
    },
  });
  return result.verified;
}
