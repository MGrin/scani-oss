import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type CoreBuild, readCoreBuild, readReleaseVersion } from '@scani/config/core-build';
import type { Plugin, Rollup } from 'vite';

/**
 * What `/version.json` carries.
 *
 * `version` is a hash of the build's own output and is what `useAppUpdate`
 * compares, so a redeploy that changed nothing in this app offers no update
 * banner, and any change to its code, styles or page does (SC-1360). `commit` is the
 * sha the build was made from, so `scripts/deploy-probe.ts --commit` can answer
 * "is my change in there" by ancestry on every Vite site rather than only on
 * the one whose bundle happens to carry a Sentry release (SC-964).
 */
export interface VersionPayload {
  readonly version: string;
  readonly buildTime: string;
  readonly commit?: string;
  readonly productVersion?: string;
  readonly coreBuild?: CoreBuild;
}

/**
 * The commit from `SCANI_COMMIT`, the build input `scripts/deploy-local.sh`
 * passes every Pages build (and the docs build has read since SC-995).
 *
 * Unset means a local build, which names no commit rather than guessing one.
 * Set but malformed is refused: a short or decorated sha would publish a
 * `version.json` the probe cannot resolve, and that reads as UNVERIFIED on
 * every later check for a reason nobody would trace back to this build.
 */
export function readCommit(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!/^[0-9a-f]{40}$/.test(raw)) {
    throw new Error(`SCANI_COMMIT must be a full 40-hex commit sha; got '${raw}'`);
  }
  return raw;
}

export function versionPayload(
  buildHash: string,
  buildTime: Date,
  commit: string | undefined,
  coreBuild?: CoreBuild,
  releaseVersion?: string
): VersionPayload {
  const productVersion = coreBuild?.productVersion ?? releaseVersion;
  return {
    version: buildHash,
    ...(productVersion ? { productVersion } : {}),
    ...(coreBuild ? { coreBuild } : {}),
    buildTime: buildTime.toISOString(),
    ...(commit === undefined ? {} : { commit }),
  };
}

/**
 * What `__SCANI_BUILD_VERSION__` reads as while the bundle is built, swapped
 * for the real version once every chunk has its final content.
 *
 * The version cannot be known before the output it hashes, and the bundle has
 * to carry it, so every hash is taken over this constant instead of over the
 * version. Its length is the version's, so the swap moves no column a source
 * map points at.
 */
export const VERSION_PLACEHOLDER = 'SCANI_BUILD_VER_';

/** A hash of every file the build emits, placeholder included. */
function contentVersion(bundle: Rollup.OutputBundle): string {
  const hash = createHash('sha256');
  for (const fileName of Object.keys(bundle).sort()) {
    const item = bundle[fileName];
    if (item === undefined) continue;
    hash.update(fileName).update('\0');
    hash.update(item.type === 'chunk' ? item.code : item.source).update('\0');
  }
  return hash.digest('hex').slice(0, VERSION_PLACEHOLDER.length);
}

/**
 * Writes `version.json` into the build output, and serves a `dev` one from the dev server.
 *
 * It also tells the bundle its own version, as `__SCANI_BUILD_VERSION__`, so
 * `useAppUpdate` can ask "is this page older than what the host serves?".
 * Without that, the only comparison available was with the version the
 * PREVIOUS visit saw, which offered the update banner to a page that had
 * already loaded the new build, once after every deploy.
 */
export function viteVersion(): Plugin {
  let buildHash = '';
  let commit: string | undefined;
  let coreBuild: CoreBuild | undefined;
  let releaseVersion: string | undefined;

  return {
    name: 'vite-version',
    config(_config, { command }) {
      buildHash = command === 'build' ? '' : 'dev';
      const told = command === 'build' ? VERSION_PLACEHOLDER : 'dev';
      commit = readCommit(process.env.SCANI_COMMIT);
      coreBuild = readCoreBuild(process.env.SCANI_CORE_BUILD, commit);
      releaseVersion = readReleaseVersion(process.env.SCANI_RELEASE_VERSION);
      return {
        define: {
          __SCANI_BUILD_VERSION__: JSON.stringify(told),
          __SCANI_CORE_BUILD__: JSON.stringify(coreBuild ?? null),
          __SCANI_RELEASE_VERSION__: JSON.stringify(releaseVersion ?? null),
          __SCANI_BUILD_COMMIT__: JSON.stringify(commit ?? null),
        },
      };
    },
    buildStart() {
      commit = readCommit(process.env.SCANI_COMMIT);
    },
    generateBundle: {
      // Last, so the hash covers what every other plugin did to the output.
      order: 'post',
      handler(_options, bundle) {
        buildHash = contentVersion(bundle);
        for (const item of Object.values(bundle)) {
          if (item.type === 'chunk' && item.code.includes(VERSION_PLACEHOLDER)) {
            item.code = item.code.replaceAll(VERSION_PLACEHOLDER, buildHash);
          }
        }
      },
    },
    writeBundle(options) {
      const outDir = options.dir || resolve(process.cwd(), 'dist');
      writeFileSync(
        resolve(outDir, 'version.json'),
        JSON.stringify(versionPayload(buildHash, new Date(), commit, coreBuild, releaseVersion))
      );
    },
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ version: 'dev', buildTime: new Date().toISOString() }));
      });
    },
  };
}
