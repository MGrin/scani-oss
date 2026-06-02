import 'reflect-metadata';

// Generating the static spec must not require live services. A dummy URL lets
// `@scani/db/connection` construct its (lazy) client without connecting.
process.env.DATABASE_URL ??= 'postgres://localhost:5433/scani';
process.env.NODE_ENV ??= 'development';
