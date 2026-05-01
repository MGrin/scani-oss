// Edge-safe replacement for `cross-fetch`. `@simplewebauthn/server` imports it
// unconditionally, and webpack picks cross-fetch's `browser` entry (which needs
// XMLHttpRequest) when bundling for Cloudflare Workers. Workers have native
// `fetch` on `globalThis`; just re-export it.
export const fetch: typeof globalThis.fetch = (...args) => globalThis.fetch(...args);
export default fetch;

export const Headers: typeof globalThis.Headers = globalThis.Headers;
export const Request: typeof globalThis.Request = globalThis.Request;
export const Response: typeof globalThis.Response = globalThis.Response;
