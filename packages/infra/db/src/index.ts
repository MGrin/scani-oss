/**
 * `@scani/db`
 *
 * Database infrastructure layer: drizzle schema (every table + pgEnum),
 * postgres.js connection, transaction helper, migration runner, and the
 * generic `BaseRepository`. Domain repositories in `@scani/domain` extend
 * `BaseRepository` and compose against the schema exported from here.
 *
 * This package is intentionally free of domain logic — it's a DB-shaped
 * API surface, not a business-rules layer.
 */

export { withAdvisoryLock } from './advisory-lock';
export { BaseRepository, type DatabaseTransaction } from './base-repository';
export {
  client,
  type DbType,
  db,
  getActiveConnectionsCount,
  getConnectionStats,
  getDb,
  getTypedDb,
  isReadOnlySession,
} from './connection';
export {
  endConnectionTracking,
  getConnectionMonitoringStats,
  recordConnectionAcquired,
  recordConnectionReleased,
  recordQueryExecuted,
  resetConnectionMonitoringStats,
  startConnectionTracking,
} from './connection-monitor';
export { type UpsertJobHeartbeatInput, upsertJobHeartbeat } from './job-heartbeat-writer';
export {
  assertNoConflictingOptionsParam,
  assertSessionReadOnly,
  isDryRunRepairScript,
  READ_ONLY_ENV_VAR,
  READ_ONLY_STARTUP_OPTION,
  REPAIR_WRITE_FLAG,
  type ReadOnlyIntentInput,
  resolveReadOnlyIntent,
} from './read-only';
// `./schema/index`, not `./schema` — a file named `schema.ts` would shadow the
// directory, and a stale one silently did until SC-278. Tables missing from
// `@scani/db` while present in `@scani/db/schema` is that shadow, not a
// resolver quirk; no table needs a hand-written re-export here.
export * from './schema/index';
export {
  checkSchemaDrift,
  type DatabaseColumnRow,
  describeSchemaDrift,
  diffSchema,
  expectedSchema,
  SCHEMA_DRIFT_TIMEOUT_MS,
  type SchemaDriftOptions,
  type SchemaDriftReport,
  SchemaDriftTimeoutError,
} from './schema-drift';
export { awaitSchemaReady, type SchemaReadyOptions } from './schema-ready';
export * from './transaction';
