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
// Explicit re-export of the waitlist table — keeps `import { waitlistSignups }
// from '@scani/db'` working even when `export *` chains drop the symbol on
// Bun's resolver under this monorepo's barrel layout. Add new tables here
// when you hit the same issue.
export {
  type NewWaitlistSignup,
  type WaitlistSignup,
  waitlistSignups,
} from './schema/cloud';
export { awaitSchemaReady, type SchemaReadyOptions } from './schema-ready';
export * from './transaction';
