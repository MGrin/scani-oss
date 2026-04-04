// Set DATABASE_URL before any module loads (connection.ts checks it at import time)
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_dummy';
}
