/**
 * Bun embeds a file imported with `type: 'file'` into the compiled binary and
 * hands back a path that resolves at runtime — which is the only way an asset
 * reaches production here, because the runtime image contains the binary and
 * nothing else (see `Dockerfile`: only `dist/server` is copied).
 *
 * TypeScript has no idea what a `.woff2` module is, so it needs telling. The
 * declaration is deliberately narrow — a string path, which is exactly what
 * `Bun.file()` takes.
 */
declare module '*.woff' {
  const path: string;
  export default path;
}
