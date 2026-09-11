import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Plugin } from 'vite';

/**
 * What `/version.json` carries.
 *
 * `version` changes with every build and is what `useAppUpdate` compares, so a
 * redeploy of the same commit still offers the update banner. `commit` is the
 * sha the build was made from, so `scripts/deploy-probe.ts --commit` can answer
 * "is my change in there" by ancestry on every Vite site rather than only on
 * the one whose bundle happens to carry a Sentry release (SC-964).
 */
export interface VersionPayload {
  readonly version: string;
  readonly buildTime: string;
  readonly commit?: string;
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
  commit: string | undefined
): VersionPayload {
  return {
    version: buildHash,
    buildTime: buildTime.toISOString(),
    ...(commit === undefined ? {} : { commit }),
  };
}

/** Writes `version.json` into the build output, and serves a `dev` one from the dev server. */
export function viteVersion(): Plugin {
  let buildHash = '';
  let commit: string | undefined;

  return {
    name: 'vite-version',
    buildStart() {
      buildHash = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      commit = readCommit(process.env.SCANI_COMMIT);
    },
    writeBundle(options) {
      const outDir = options.dir || resolve(process.cwd(), 'dist');
      writeFileSync(
        resolve(outDir, 'version.json'),
        JSON.stringify(versionPayload(buildHash, new Date(), commit))
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
