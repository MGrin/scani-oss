// Drizzle schema barrel — single import point for tables, relations, and
// types. Apps and the domain layer should import from here:
//   `import * as schema from '@scani/db/schema'`  ← typical
//   `import { users, holdings, type Token } from '@scani/db'`
//
// Add a new table → drop a new file alongside the others (or extend an
// existing one if it belongs to an existing entity bundle), then add the
// re-export here. drizzle-kit reads this barrel via drizzle.config.ts so
// `bun run db:generate` picks up new tables automatically.

export * from './accounts';
export * from './admin-audit-log';
export * from './cloud';
export * from './groups';
export * from './holdings';
export * from './institutions';
export * from './job-heartbeats';
export * from './portfolio';
export * from './tokens';
export * from './user-integration-credentials';
export * from './user-jobs';
export * from './user-wallets';
export * from './users';
export * from './vaults';
