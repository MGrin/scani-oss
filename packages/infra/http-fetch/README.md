# @scani/http-fetch

Bounded HTTP fetcher for arbitrary user-supplied URLs. Pure functions; no DI; one consumer-side guard surface — call `fetchHtmlBounded(url)` and either get back the response (truncated to 512KB) or a `BoundedFetchError` you can map to a user-visible message.

Owns:

- `fetchHtmlBounded(url)` — hard 4s timeout, SSRF-resolved DNS guard, response-size cap (512KB), `text/*` content-type enforcement, follow-redirects with the same guards on the final URL.
- `BoundedFetchError` — discriminated by `reason: 'invalid-url' | 'blocked-host' | 'timeout' | 'bad-status' | 'bad-content-type' | 'too-large' | 'network'` so callers can decide which surface to translate.

## Why a separate package

Originally a 250-LOC file copy-pasted between `apps/backend/api/src/lib/fetch-html-bounded.ts` and `apps/backend/data-provider/src/lib/fetch-html-bounded.ts`. Both routers (api's institution-autofill, data-provider's `og.*` route) need the same SSRF-hardened fetch with the same caps; any guard fix landed in one app while the other carried the vulnerable copy.

Separate package keeps a single source of truth. Pure-function design means no DI plumbing, no `reflect-metadata`, no Bun runtime weirdness — both apps' compiled binaries embed the same code path.

## Usage

```ts
import { BoundedFetchError, fetchHtmlBounded } from '@scani/http-fetch';

try {
  const { html, truncated, finalUrl } = await fetchHtmlBounded('https://revolut.com');
  // pass `html` into open-graph-scraper / cheerio / your parser of choice
} catch (err) {
  if (err instanceof BoundedFetchError && err.reason === 'blocked-host') {
    // user-supplied URL resolved to a private IP — refuse politely
  }
  // …
}
```

## Guards

| Guard | Limit | Reason |
|---|---|---|
| Protocol | `http:` / `https:` only | Block `file:`, `gopher:`, etc. |
| Hostname | DNS-resolved; reject private/loopback/link-local/CGNAT/multicast IPv4 + IPv6 ULA + IPv4-mapped IPv6 | SSRF — user can't make us hit `169.254.169.254` (cloud metadata) or `127.0.0.1` (local services). |
| Hostname (literal IP) | Same range check on the literal IP | URL like `http://169.254.169.254/` is rejected before DNS. |
| Hostname suffix | `.internal`, `.flycast`, `.fly.dev` blocked | Block our own service mesh. |
| Total time | 4s (`AbortSignal.timeout`) | Fly machines have small budgets; a stuck peer can't pin the request. |
| Body size | 512KB streamed cap | OG / Twitter Card tags are always in `<head>`; the first ~32KB is enough for ~99% of pages, 512KB is the comfort margin. |
| Content-Length header | Reject if peer declares > 4× cap (2MB) | Don't even start reading on flagrantly-oversized pages. |
| Content-Type | Must start with `text/` or include `xhtml` | JSON / images / binary are rejected before reading. |

## Tests

```bash
bun test packages/infra/http-fetch --timeout 30000
```

Covers each guard in isolation: invalid URL, blocked protocol, blocked literal IP, blocked private DNS resolution, timeout, bad status, bad content-type, oversized Content-Length, and the streaming truncation path.
