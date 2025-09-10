import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { type Context, createContext, publicProcedure, router } from './trpc';

describe('tRPC Setup', () => {
  describe('createContext', () => {
    it('should return context object with requestId and startTime', () => {
      const context = createContext();
      expect(typeof context).toBe('object');
      expect(context).toHaveProperty('requestId');
      expect(context).toHaveProperty('startTime');
      expect(typeof context.requestId).toBe('string');
      expect(typeof context.startTime).toBe('number');
      expect(context.requestId.length).toBeGreaterThan(0);
    });

    it('should return Context type', () => {
      const context: Context = createContext();
      expect(context).toBeDefined();
    });
  });

  describe('router and procedure exports', () => {
    it('should export router function', () => {
      expect(typeof router).toBe('function');

      // Test creating a basic router
      const testRouter = router({
        test: publicProcedure.query(() => 'test'),
      });

      expect(testRouter).toBeDefined();
    });

    it('should export publicProcedure', () => {
      expect(publicProcedure).toBeDefined();
      expect(typeof publicProcedure.query).toBe('function');
      expect(typeof publicProcedure.mutation).toBe('function');
    });
  });

  describe('errorFormatter', () => {
    it('should format errors correctly', async () => {
      // Create a test procedure that throws an error
      const testRouter = router({
        throwError: publicProcedure.query(() => {
          throw new Error('Test error message');
        }),
      });

      const caller = testRouter.createCaller(createContext());

      // Test that the error formatter is called and returns the shape
      try {
        await caller.throwError();
        // Should not reach here
        expect(true).toBe(false);
      } catch (error: unknown) {
        expect(error).toBeDefined();
        expect(error instanceof Error).toBe(true);
        if (error instanceof Error) {
          expect(error.message).toBe('Test error message');
        }
      }
    });

    it('should format different types of errors', async () => {
      // Test with different error types to ensure errorFormatter coverage
      const testRouter = router({
        throwCustomError: publicProcedure.query(() => {
          const error = new Error('Custom error');
          error.name = 'CustomError';
          throw error;
        }),
        throwStringError: publicProcedure.query(() => {
          throw 'String error';
        }),
      });

      const caller = testRouter.createCaller(createContext());

      // Test custom error
      try {
        await caller.throwCustomError();
        expect(false).toBe(true); // Should not reach here
      } catch (error: unknown) {
        expect(error).toBeDefined();
      }

      // Test string error
      try {
        await caller.throwStringError();
        expect(false).toBe(true); // Should not reach here
      } catch (error: unknown) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('full tRPC integration', () => {
    it('should handle complex router with multiple procedures', () => {
      // Create a more comprehensive router to test all functionality
      const complexRouter = router({
        hello: publicProcedure.query(() => 'Hello World'),
        echo: publicProcedure
          .input(z.object({ message: z.string() }))
          .query(({ input }) => input.message),
        add: publicProcedure
          .input(z.object({ a: z.number(), b: z.number() }))
          .mutation(({ input }) => input.a + input.b),
      });

      expect(complexRouter).toBeDefined();

      // Test that we can create a caller
      const caller = complexRouter.createCaller(createContext());
      expect(caller).toBeDefined();
      expect(typeof caller.hello).toBe('function');
      expect(typeof caller.echo).toBe('function');
      expect(typeof caller.add).toBe('function');
    });

    it('should work with context', async () => {
      const contextRouter = router({
        getContext: publicProcedure.query(({ ctx }) => {
          return ctx;
        }),
      });

      const context = createContext();
      const caller = contextRouter.createCaller(context);

      const result = await caller.getContext();
      expect(result).toHaveProperty('requestId');
      expect(result).toHaveProperty('startTime');
      expect(typeof result.requestId).toBe('string');
      expect(typeof result.startTime).toBe('number');
    });
  });
});
