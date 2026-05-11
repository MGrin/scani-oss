import { NextResponse } from 'next/server';

export const runtime = 'edge';
export const dynamic = 'force-static';

// Plain JS that drives /auth/login. Deliberately not a React Client
// Component — we observed React hydration silently failing on iOS Brave
// after the cookie-based flow was replaced (#473), leaving the button
// non-interactive with no error surfaced. This bypasses Next.js's
// client-side reconciliation entirely: the page is static HTML and this
// script attaches the click listener on DOMContentLoaded.
const SCRIPT = String.raw`
(function () {
  function b64urlToBuffer(s) {
    var pad = s.length % 4 ? 4 - (s.length % 4) : 0;
    var b64 = (s + '===='.slice(0, pad)).replace(/-/g, '+').replace(/_/g, '/');
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  function bufferToB64url(buf) {
    var bytes = new Uint8Array(buf);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function init() {
    var btn = document.getElementById('signin-button');
    var errorEl = document.getElementById('signin-error');
    var statusEl = document.getElementById('signin-status');
    if (!btn) return;
    if (statusEl) statusEl.textContent = 'Ready';
    btn.setAttribute('data-script-loaded', '1');

    // Document-level capture-phase diagnostics. If any tap reaches the
    // page at all, one of these fires before any listener on a child
    // could swallow it. The status line shows event name + which element
    // received it. If "Ready" stays unchanged even after these, no event
    // of any kind is reaching the document — points at an iOS Brave or
    // overlay-level interception.
    function logEvent(name) {
      return function (e) {
        if (!statusEl) return;
        var t = e.target || e.srcElement;
        var label = t && t.id ? '#' + t.id : t && t.tagName ? t.tagName : '?';
        statusEl.textContent = name + ' → ' + label;
      };
    }
    document.addEventListener('pointerdown', logEvent('pointerdown'), true);
    document.addEventListener('touchstart', logEvent('touchstart'), true);
    document.addEventListener('mousedown', logEvent('mousedown'), true);
    document.addEventListener('click', logEvent('click'), true);

    var attempted = false;
    async function runSignin(via) {
      if (attempted) return;
      attempted = true;
      if (statusEl) statusEl.textContent = 'event: ' + via;
      btn.disabled = true;
      btn.textContent = 'Waiting for passkey…';
      if (errorEl) errorEl.textContent = '';
      try {
        var options = JSON.parse(btn.getAttribute('data-options'));
        var token = btn.getAttribute('data-token');
        var next = btn.getAttribute('data-next') || '/';
        var publicKey = {
          challenge: b64urlToBuffer(options.challenge),
          rpId: options.rpId,
          timeout: options.timeout,
          userVerification: options.userVerification,
          allowCredentials: (options.allowCredentials || []).map(function (c) {
            return { id: b64urlToBuffer(c.id), type: c.type, transports: c.transports };
          }),
        };
        var cred = await navigator.credentials.get({ publicKey: publicKey });
        var response = {
          id: cred.id,
          rawId: bufferToB64url(cred.rawId),
          type: cred.type,
          response: {
            authenticatorData: bufferToB64url(cred.response.authenticatorData),
            clientDataJSON: bufferToB64url(cred.response.clientDataJSON),
            signature: bufferToB64url(cred.response.signature),
            userHandle: cred.response.userHandle ? bufferToB64url(cred.response.userHandle) : null,
          },
          clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
          authenticatorAttachment: cred.authenticatorAttachment || null,
        };
        var res = await fetch('/auth/login/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          cache: 'no-store',
          body: JSON.stringify({ response: response, token: token }),
        });
        var data = await res.json();
        if (!data.ok) {
          attempted = false;
          btn.disabled = false;
          btn.textContent = 'Sign in with passkey';
          if (errorEl) errorEl.textContent = data.error || 'Sign-in failed';
          return;
        }
        window.location.href = next;
      } catch (err) {
        attempted = false;
        btn.disabled = false;
        btn.textContent = 'Sign in with passkey';
        if (errorEl) errorEl.textContent = err && err.message ? err.message : String(err);
      }
    }

    // Button-level handlers still attached, but the document-level
    // capture listeners above will fire first regardless.
    btn.addEventListener('click', function () {
      runSignin('click');
    });
    btn.addEventListener('touchend', function () {
      runSignin('touchend');
    });
    btn.onclick = function () {
      runSignin('onclick');
    };
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`;

export function GET(): NextResponse {
  return new NextResponse(SCRIPT, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'no-store, must-revalidate',
    },
  });
}
