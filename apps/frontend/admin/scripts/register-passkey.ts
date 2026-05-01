#!/usr/bin/env bun
/**
 * Local passkey registration for the admin app.
 *
 * Usage:
 *   bun apps/admin/scripts/register-passkey.ts
 *   # then open http://localhost:5177 in a browser on the same machine
 *
 * Output:
 *   ADMIN_PASSKEY_CREDENTIAL_ID=...
 *   ADMIN_PASSKEY_PUBLIC_KEY=...
 *   ADMIN_SESSION_SECRET=...
 *
 * Copy those three values into Cloudflare Pages secrets (prod) or
 * apps/admin/.env.local (local). The script exits automatically after
 * the browser POSTs back the credential.
 *
 * This registration targets rpID=localhost by default. For a prod
 * passkey pass --rp-id admin.scani.xyz --origin https://admin.scani.xyz.
 * That registration will only work after admin.scani.xyz is live.
 */

import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/types';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  const val = process.argv[i + 1];
  if (key?.startsWith('--') && val) args.set(key.slice(2), val);
}

const RP_ID = args.get('rp-id') ?? 'localhost';
const ORIGIN = args.get('origin') ?? 'http://localhost:5177';
const PORT = Number.parseInt(args.get('port') ?? '5177', 10);

const USER_ID_BYTES = crypto.getRandomValues(new Uint8Array(16));
const USERNAME = args.get('username') ?? 'admin';
const CHALLENGE_STORE: { challenge: string | null } = { challenge: null };

function b64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function handleBegin(): Promise<Response> {
  const options = await generateRegistrationOptions({
    rpName: 'scani admin',
    rpID: RP_ID,
    userID: USER_ID_BYTES,
    userName: USERNAME,
    attestationType: 'none',
    authenticatorSelection: {
      userVerification: 'preferred',
      residentKey: 'preferred',
    },
  });
  CHALLENGE_STORE.challenge = options.challenge;
  return Response.json(options);
}

async function handleComplete(req: Request): Promise<Response> {
  if (!CHALLENGE_STORE.challenge) {
    return new Response('No challenge in progress', { status: 400 });
  }
  const body = (await req.json()) as RegistrationResponseJSON;
  const result = await verifyRegistrationResponse({
    response: body,
    expectedChallenge: CHALLENGE_STORE.challenge,
    expectedOrigin: ORIGIN,
    expectedRPID: RP_ID,
  });
  if (!result.verified || !result.registrationInfo) {
    return new Response('Verification failed', { status: 400 });
  }
  const info = result.registrationInfo;
  const credentialId = info.credential.id;
  const publicKey = b64urlEncode(info.credential.publicKey);

  const sessionSecret = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)));

  const block = [
    '',
    '=== Registration complete — copy these values ===',
    '',
    `ADMIN_RP_ID=${RP_ID}`,
    `ADMIN_ORIGIN=${ORIGIN}`,
    `ADMIN_PASSKEY_CREDENTIAL_ID=${credentialId}`,
    `ADMIN_PASSKEY_PUBLIC_KEY=${publicKey}`,
    `ADMIN_SESSION_SECRET=${sessionSecret}`,
    '',
    'Local dev  → paste into apps/admin/.env.local',
    'Production → wrangler pages secret put <KEY> --project-name scani-admin',
    '',
  ].join('\n');

  console.log(block);

  setTimeout(() => process.exit(0), 500);

  return Response.json({ ok: true });
}

const HTML = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Register admin passkey</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #fafafa; margin: 0; padding: 2rem; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { max-width: 420px; border: 1px solid #262626; background: #171717aa; padding: 1.5rem; border-radius: 0.5rem; }
  h1 { font-size: 1.1rem; margin: 0 0 0.5rem; }
  p { color: #a3a3a3; font-size: 0.85rem; margin: 0 0 1rem; }
  button { background: #262626; border: 1px solid #404040; color: #fafafa; padding: 0.5rem 1rem; border-radius: 0.375rem; cursor: pointer; font-size: 0.9rem; width: 100%; }
  button:hover { background: #404040; }
  #out { margin-top: 1rem; font-size: 0.8rem; color: #a3e635; white-space: pre-wrap; word-break: break-all; }
  .err { color: #fca5a5 !important; }
</style></head>
<body>
<div class="card">
  <h1>Register admin passkey</h1>
  <p>Click below, authenticate with your device/1Password, then copy the printed values from the terminal into <code>apps/admin/.env.local</code> or Cloudflare Pages secrets.</p>
  <button id="go">Create passkey</button>
  <div id="out"></div>
</div>
<script type="module">
  import { startRegistration } from 'https://esm.sh/@simplewebauthn/browser@11';
  const out = document.getElementById('out');
  const go = document.getElementById('go');
  go.onclick = async () => {
    out.className = ''; out.textContent = 'Talking to browser…';
    try {
      const options = await fetch('/begin', { method: 'POST' }).then(r => r.json());
      const response = await startRegistration({ optionsJSON: options });
      const done = await fetch('/complete', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(response) });
      if (!done.ok) throw new Error(await done.text());
      out.textContent = 'Done — check the terminal. You can close this tab.';
    } catch (e) {
      out.className = 'err';
      out.textContent = String(e && e.message || e);
    }
  };
</script>
</body></html>`;

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname === '/') {
      return new Response(HTML, { headers: { 'content-type': 'text/html' } });
    }
    if (req.method === 'POST' && url.pathname === '/begin') {
      return handleBegin();
    }
    if (req.method === 'POST' && url.pathname === '/complete') {
      return handleComplete(req);
    }
    return new Response('Not found', { status: 404 });
  },
});

console.log(`\nPasskey registration server up: ${ORIGIN}`);
console.log(`  rpID   = ${RP_ID}`);
console.log(`  origin = ${ORIGIN}`);
console.log('\nOpen the URL in a browser on this machine, then click "Create passkey".\n');
console.log('  listening on', server.hostname, server.port);
