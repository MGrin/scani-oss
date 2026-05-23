// Point repository tests at the running compose Postgres. The compose
// stack is the standard local dev harness (`bun run dev:stack`); tests
// don't provision their own DB. Per-test isolation is provided by
// `withTestDb` (see test/helpers/db.ts), which wraps each test body in
// a transaction and rolls back on exit.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://scani:scani@localhost:5433/scani?sslmode=disable';
}
// reflect-metadata must load before any @Service() class, since TypeDI
// reads decorator metadata at class-init time.
import 'reflect-metadata';
