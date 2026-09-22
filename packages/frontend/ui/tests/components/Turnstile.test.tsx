import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
// The server's own constant, by path: the two must name the same header or
// every checked request arrives without a token.
import { TURNSTILE_HEADER as SERVER_HEADER } from '../../../../infra/http-fetch/src/turnstile';
import {
  TURNSTILE_HEADER,
  TurnstileWidget,
  turnstileBlocksSubmit,
  turnstileHeaders,
} from '../../src/components/Turnstile';

describe('turnstileHeaders', () => {
  it('sends nothing when there is no token, so an unkeyed build sends no header', () => {
    expect(turnstileHeaders(null)).toEqual({});
    expect(turnstileHeaders(undefined)).toEqual({});
  });

  it('carries the token under the header the server reads', () => {
    expect(turnstileHeaders('tok')).toEqual({ [SERVER_HEADER]: 'tok' });
    expect(TURNSTILE_HEADER).toBe(SERVER_HEADER);
  });
});

describe('TurnstileWidget', () => {
  it('renders nothing without a site key', () => {
    expect(renderToStaticMarkup(<TurnstileWidget siteKey={undefined} onToken={() => {}} />)).toBe(
      ''
    );
    expect(renderToStaticMarkup(<TurnstileWidget siteKey="" onToken={() => {}} />)).toBe('');
  });

  it('renders the container Cloudflare draws into when keyed', () => {
    const markup = renderToStaticMarkup(<TurnstileWidget siteKey="0x4AAA" onToken={() => {}} />);
    expect(markup).toContain('data-ui="turnstile"');
  });
});

// SC-1266: a check that failed to run must not lock the form. The server is the
// gate; a returning cloud visitor whose stale service worker blocked the script
// could not sign in at all while the button waited for a token that never came.
describe('turnstileBlocksSubmit', () => {
  it('waits for a token while the check is running — the control', () => {
    expect(turnstileBlocksSubmit({ required: true, token: null, failed: false })).toBe(true);
  });

  it('does not block once the check has FAILED to run', () => {
    expect(turnstileBlocksSubmit({ required: true, token: null, failed: true })).toBe(false);
  });

  it('does not block with a token, or with no site key', () => {
    expect(turnstileBlocksSubmit({ required: true, token: 'tok', failed: false })).toBe(false);
    expect(turnstileBlocksSubmit({ required: false, token: null, failed: false })).toBe(false);
  });

  it('every form gates on it rather than on its own required && !token', async () => {
    const root = new URL('../../../../../apps/frontend/', import.meta.url).pathname;
    // cloud and landing are not in the public mirror; app is in both trees,
    // so it is read unconditionally and a missing app file is a failure.
    const files = ['app/src/pages/Auth.tsx'];
    for (const f of ['cloud/src/pages/AuthPage.tsx', 'landing/src/components/sections/Contact.tsx'])
      if (await Bun.file(root + f).exists()) files.push(f);
    for (const file of files) {
      const source = await Bun.file(root + file).text();
      expect(source).toContain('turnstile.blocksSubmit');
      expect(source).not.toMatch(/turnstile\.required\s*&&\s*!turnstile\.token/);
    }
  });
});
