import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
// The server's own constant, by path: the two must name the same header or
// every checked request arrives without a token.
import { TURNSTILE_HEADER as SERVER_HEADER } from '../../../../infra/http-fetch/src/turnstile';
import {
  TURNSTILE_HEADER,
  TurnstileWidget,
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
