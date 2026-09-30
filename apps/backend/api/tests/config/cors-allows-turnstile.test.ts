import { describe, expect, test } from 'bun:test';
import { TURNSTILE_HEADER } from '@scani/http-fetch';

/**
 * SC-1266. The sign-in widget sends its token on `TURNSTILE_HEADER`, a custom
 * header, so the browser preflights the POST and blocks it unless the server's
 * CORS `allowedHeaders` names it. #1859 shipped the widget to app.scani.xyz
 * with the api's list missing it, and every sign-in failed as "We couldn't
 * reach Scani". The api is the only server that takes the token on a header:
 * the data-provider's `/api/auth` surface, which did too, is gone, and its
 * contact form carries the token in the tRPC input.
 */

const SERVERS = ['apps/backend/api/src/index.ts'];
const ROOT = new URL('../../../../../', import.meta.url).pathname;

describe('CORS lets the Turnstile token through the preflight', () => {
  for (const file of SERVERS) {
    test(file, async () => {
      const source = await Bun.file(ROOT + file).text();
      const lists = [...source.matchAll(/allowedHeaders:\s*\[([^\]]*)\]/g)].map((m) => m[1]);
      // The control: the list was found at all, so a miss below is a real miss.
      expect(lists).toHaveLength(1);
      expect(lists[0]).toContain('TURNSTILE_HEADER');
      expect(source).toMatch(/import \{[^}]*\bTURNSTILE_HEADER\b[^}]*\} from '@scani\/http-fetch'/);
      expect(TURNSTILE_HEADER).toBe('x-turnstile-token');
    });
  }
});
