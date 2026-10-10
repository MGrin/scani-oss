/**
 * What a failed migration prints (SC-1585). Handing the raw error to
 * `console.error` lets Bun's inspector print an excerpt of the compiled
 * binary's minified source ahead of the message. The stack is printed only
 * when asked for, with `SCANI_MIGRATE_DEBUG=1`.
 */
export function migrationFailureLines(error: unknown, opts: { debug: boolean }): string[] {
  const lines = ['❌ Migration failed:'];
  if (!(error instanceof Error)) {
    lines.push(`   ${String(error)}`);
    return lines;
  }
  const pg = error as Error & { code?: string; table_name?: string; constraint_name?: string };
  const parts = [error.message];
  if (pg.code) parts.push(`code ${pg.code}`);
  if (pg.table_name) parts.push(`table ${pg.table_name}`);
  if (pg.constraint_name) parts.push(`constraint ${pg.constraint_name}`);
  lines.push(`   ${parts.join(' · ')}`);
  if (opts.debug && error.stack) lines.push(error.stack);
  return lines;
}
