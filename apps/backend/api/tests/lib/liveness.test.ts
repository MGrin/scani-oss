import { describe, expect, test } from 'bun:test';
import { isLivenessProbe } from '../../src/lib/liveness';

const get = (url: string) => new Request(url);
const method = (url: string, m: string) => new Request(url, { method: m });

describe('isLivenessProbe', () => {
  test('the path Fly checks is exempt, on both verbs it may use', () => {
    expect(isLivenessProbe(get('https://api.scani.xyz/health'))).toBe(true);
    expect(isLivenessProbe(method('https://api.scani.xyz/health', 'HEAD'))).toBe(true);
  });

  test('a query string or trailing content does not change the answer', () => {
    expect(isLivenessProbe(get('https://api.scani.xyz/health?from=fly'))).toBe(true);
    expect(isLivenessProbe(get('https://api.scani.xyz/health#x'))).toBe(true);
  });

  test('the DEPENDENCY probes are not exempt', () => {
    // Their job is to fail when Redis or the DB is unreachable, and
    // `deploy-local.sh` smokes `/health/deep` after every worker deploy. A
    // prefix match here would exempt them and hand an unauthenticated caller
    // an unmetered path that opens real connections.
    expect(isLivenessProbe(get('https://api.scani.xyz/health/deep'))).toBe(false);
    expect(isLivenessProbe(get('https://api.scani.xyz/health/db'))).toBe(false);
    expect(isLivenessProbe(get('https://api.scani.xyz/readyz'))).toBe(false);
  });

  test('a lookalike path is not exempt', () => {
    expect(isLivenessProbe(get('https://api.scani.xyz/healthz'))).toBe(false);
    expect(isLivenessProbe(get('https://api.scani.xyz/health-check'))).toBe(false);
    expect(isLivenessProbe(get('https://api.scani.xyz/api/health'))).toBe(false);
  });

  test('a write verb is never the probe', () => {
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isLivenessProbe(method('https://api.scani.xyz/health', verb))).toBe(false);
    }
  });
});
