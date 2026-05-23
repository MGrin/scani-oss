// Tests in this app pull in `@scani/db` transitively (the cloud_api_keys
// drizzle table is re-exported from there). That package's connection
// module throws at import time if DATABASE_URL is unset. The unit tests
// here don't actually open a connection — they hash strings, validate
// bearer headers, and mock the db at the call site — so a syntactically
// valid placeholder URL is enough to satisfy the boot guard without
// touching a real database.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://scani:scani@localhost:5433/scani?sslmode=disable';
}
