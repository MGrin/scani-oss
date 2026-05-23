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
export * from './schema';
export { awaitSchemaReady, type SchemaReadyOptions } from './schema-ready';
export * from './transaction';
