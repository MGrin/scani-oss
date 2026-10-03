import '../../i18n-preload';
import { afterEach, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ScaniBrand } from '../../../src/v3/layouts/ScaniBrand';

/**
 * SC-1484: the header names the release a build was published as, and a build
 * that was given none claims none. Public release images carry the release in
 * `__SCANI_RELEASE_VERSION__`; private builds carry it in their Core mapping.
 */

const g = globalThis as Record<string, unknown>;

// The build's per-commit facts live in a meta tag the plugin writes (SC-1521);
// renderToStaticMarkup has no DOM, so the tag is stood in for.
function setCoreBuild(coreBuild: unknown) {
  g.document = {
    querySelector: () => ({ content: JSON.stringify({ commit: null, coreBuild }) }),
  };
}

afterEach(() => {
  delete g.__SCANI_RELEASE_VERSION__;
  delete g.document;
});

const label = () => renderToStaticMarkup(createElement(ScaniBrand));

describe('ScaniBrand names the release it was built as', () => {
  test('a local or self-built image reads Development', () => {
    expect(label()).toContain('Development');
    g.__SCANI_RELEASE_VERSION__ = null;
    setCoreBuild(null);
    expect(label()).toContain('Development');
  });

  test('a release image reads its own version', () => {
    g.__SCANI_RELEASE_VERSION__ = '0.51.0';
    const html = label();
    expect(html).toContain('v0.51.0');
    expect(html).not.toContain('Development');
  });

  test("a private build's Core mapping wins", () => {
    g.__SCANI_RELEASE_VERSION__ = '0.51.0';
    setCoreBuild({
      productVersion: '0.50.0',
      releaseCommit: 'a'.repeat(40),
      coreFingerprint: 'b'.repeat(64),
      pendingChangeCount: 3,
    });
    expect(label()).toContain('v0.50.0');
  });
});
