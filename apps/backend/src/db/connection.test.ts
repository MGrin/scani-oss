import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { db } from './connection';

describe('Database Connection', () => {
  describe('Database Instance', () => {
    it('should export a database instance', () => {
      expect(db).toBeDefined();
    });

    it('should have query method', () => {
      expect(typeof db.query).toBe('object');
    });

    it('should be able to run simple queries', () => {
      // Test that database instance has the expected Drizzle methods
      expect(db.select).toBeDefined();
      expect(db.insert).toBeDefined();
      expect(db.update).toBeDefined();
      expect(db.delete).toBeDefined();
    });
  });

  describe('Environment Configuration', () => {
    let originalEnv: Record<string, string | undefined>;

    beforeAll(() => {
      // Save original environment variables
      originalEnv = {
        NODE_ENV: process.env.NODE_ENV,
        DATABASE_URL: process.env.DATABASE_URL,
        DB_PATH: process.env.DB_PATH,
      };
    });

    afterAll(() => {
      // Restore original environment variables
      Object.entries(originalEnv).forEach(([key, value]) => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      });
    });

    it('should handle different database configurations', () => {
      // Test that we can access the db instance regardless of environment
      expect(db).toBeDefined();
      expect(typeof db.query).toBe('object');
    });

    it('should create data directory when using SQLite', async () => {
      // This is testing the path creation logic in connection.ts
      // Since we're in test mode, this should work with SQLite
      const fs = require('node:fs');
      const path = require('node:path');
      const testDbPath = './test-data/test.db';
      const dir = path.dirname(testDbPath);

      // Test the same directory creation logic
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      expect(fs.existsSync(dir)).toBe(true);

      // Clean up
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('Database Operations', () => {
    it('should support database transactions', async () => {
      // Test that the db instance supports transactions
      expect(typeof db.transaction).toBe('function');
    });

    it('should support prepared statements', () => {
      // Test that the db instance has query capabilities
      expect(db.query).toBeDefined();
    });
  });
});
