import { describe, expect, test } from 'bun:test';
import { checkRobots, parseSitemapDirectives } from '../scripts/check-robots';

/**
 * `check-robots` is a build-time guard, so the only thing worth testing about
 * it is that it CAN FAIL — and fail on the specific mistake it exists for.
 *
 * The mistake is writing `Sitemap: .../sitemap.xml`. Starlight registers
 * `@astrojs/sitemap`, which emits `sitemap-index.xml` and `sitemap-0.xml` and
 * no `sitemap.xml` at all. A robots.txt naming the obvious file serves 200,
 * parses, validates against every robots.txt linter, and points every crawler
 * at a 404 — and on this host that 404 is a 12904-byte HTML page, so a check
 * that reads the body size sees success.
 *
 * Every arm below is paired with one that must read the opposite. A guard
 * tested only against a healthy tree has never shown it can fire, and that is
 * indistinguishable from a guard that is not running.
 */

const SITE = 'https://docs.scani.xyz';

/** What the build actually emits, as measured from a real `dist/`. */
const EMITTED = new Set(['robots.txt', 'sitemap-index.xml', 'sitemap-0.xml', 'index.html']);

const GOOD = 'User-agent: *\nAllow: /\n\nSitemap: https://docs.scani.xyz/sitemap-index.xml\n';

describe('checkRobots — the mistake it exists for', () => {
  test('the shipped robots.txt passes', () => {
    expect(checkRobots({ robotsText: GOOD, emittedOrigin: SITE, distPaths: EMITTED })).toEqual([]);
  });

  test('naming sitemap.xml fails, and says what the build does emit', () => {
    const errors = checkRobots({
      robotsText: GOOD.replace('sitemap-index.xml', 'sitemap.xml'),
      emittedOrigin: SITE,
      distPaths: EMITTED,
    });

    // must-be-FOUND, and it must DISAGREE with the arm above — otherwise the
    // two are one measurement and neither says the check discriminates.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('/sitemap.xml');
    // Naming the alternatives is the whole remedy: the failure a reader hits
    // is "this file is not there", and the next question is always "then what
    // is?".
    expect(errors[0]).toContain('/sitemap-index.xml');
    expect(errors[0]).toContain('/sitemap-0.xml');
  });
});

describe('checkRobots — the other ways it can be wrong', () => {
  test('an absent robots.txt is a failure, not an empty pass', () => {
    const absent = checkRobots({ robotsText: null, emittedOrigin: SITE, distPaths: EMITTED });
    // must-be-FOUND...
    expect(absent).toHaveLength(1);
    expect(absent[0]).toContain('missing');
    // ...against a control that must read the opposite on the same inputs.
    expect(checkRobots({ robotsText: GOOD, emittedOrigin: SITE, distPaths: EMITTED })).toEqual([]);
  });

  test('a robots.txt with no Sitemap line fails', () => {
    const errors = checkRobots({
      robotsText: 'User-agent: *\nAllow: /\n',
      emittedOrigin: SITE,
      distPaths: EMITTED,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('no `Sitemap:` line');
  });

  test('a relative Sitemap path fails — robots.txt does not resolve one', () => {
    const errors = checkRobots({
      robotsText: 'Sitemap: /sitemap-index.xml\n',
      emittedOrigin: SITE,
      distPaths: EMITTED,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('not an absolute URL');

    // Control: the identical path made absolute passes, so the arm above is
    // about the relativeness and not about the path.
    expect(
      checkRobots({
        robotsText: 'Sitemap: https://docs.scani.xyz/sitemap-index.xml\n',
        emittedOrigin: SITE,
        distPaths: EMITTED,
      })
    ).toEqual([]);
  });

  test('a sitemap on another host fails even though the file name is right', () => {
    const errors = checkRobots({
      robotsText: 'Sitemap: https://scani.xyz/sitemap-index.xml\n',
      emittedOrigin: SITE,
      distPaths: EMITTED,
    });
    // This is the one that would survive a `curl` check: scani.xyz serves a
    // real sitemap, so fetching the URL returns 200 and valid XML. It is still
    // wrong, because a sitemap for another origin is discarded.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('points at https://scani.xyz');
  });

  test('every emitted sitemap being present is not enough — the named one must be', () => {
    // The build emits both files; robots.txt names one that is not among them.
    const errors = checkRobots({
      robotsText: 'Sitemap: https://docs.scani.xyz/sitemap-2.xml\n',
      emittedOrigin: SITE,
      distPaths: EMITTED,
    });
    expect(errors).toHaveLength(1);
    // must-be-ABSENT: the check must not be satisfied by "some sitemap exists".
    expect(errors[0]).not.toContain('emits no sitemap at all');
  });

  test('a build that emits no sitemap at all is reported as such', () => {
    const errors = checkRobots({
      robotsText: GOOD,
      emittedOrigin: SITE,
      distPaths: new Set(['robots.txt', 'index.html']),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('emits no sitemap at all');
  });
});

describe('parseSitemapDirectives', () => {
  test('reads the directive however it is cased and spaced', () => {
    const found = parseSitemapDirectives(
      'User-agent: *\nsitemap:https://a.test/s.xml\n  SITEMAP :  https://b.test/s.xml  \n'
    );
    expect(found.map((d) => d.raw)).toEqual(['https://a.test/s.xml', 'https://b.test/s.xml']);
  });

  test('does not mistake other directives for it', () => {
    // must-be-ABSENT, paired with the arm above: a parser that matched loosely
    // would report these and the healthy case would look identical.
    expect(
      parseSitemapDirectives('User-agent: *\nAllow: /\nDisallow: /sitemap-index.xml\n')
    ).toEqual([]);
  });
});
