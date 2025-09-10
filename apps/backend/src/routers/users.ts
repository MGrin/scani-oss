import { CreateUserSchema, CurrencyCode, UpdateUserSchema } from '@scani/shared/types';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { publicProcedure, router } from '../trpc';

// Type assertion for router operations (development/test environment uses SQLite)
const routerDb = db as ReturnType<typeof import('drizzle-orm/bun-sqlite').drizzle>;

export const usersRouter = router({
  // Get all users
  getAll: publicProcedure.query(async () => {
    const users = await routerDb.select().from(schema.users).orderBy(schema.users.name);
    return users;
  }),

  // Get user by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const [user] = await routerDb
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, input.id))
      .limit(1);

    if (!user) {
      throw new Error('User not found');
    }
    return user;
  }),

  // Create new user
  create: publicProcedure.input(CreateUserSchema).mutation(async ({ input }) => {
    try {
      const now = new Date();
      const userData = {
        id: nanoid(),
        ...input,
        createdAt: now,
        updatedAt: now,
      };

      const [createdUser] = await routerDb.insert(schema.users).values(userData).returning();

      if (!createdUser) {
        throw new Error('Failed to create user');
      }

      return createdUser;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('UNIQUE constraint failed: users.email')
      ) {
        throw new Error('User with this email already exists');
      }
      throw error;
    }
  }),

  // Update user
  update: publicProcedure
    .input(
      z.object({
        id: z.string(),
        data: UpdateUserSchema,
      })
    )
    .mutation(async ({ input }) => {
      const [updatedUser] = await routerDb
        .update(schema.users)
        .set({
          ...input.data,
          updatedAt: new Date(),
        })
        .where(eq(schema.users.id, input.id))
        .returning();

      if (!updatedUser) {
        throw new Error('User not found');
      }

      return updatedUser;
    }),

  // Delete user
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const [deletedUser] = await routerDb
      .delete(schema.users)
      .where(eq(schema.users.id, input.id))
      .returning();

    if (!deletedUser) {
      throw new Error('User not found');
    }

    return { success: true, deleted: deletedUser };
  }),

  // Get supported currencies
  getSupportedCurrencies: publicProcedure.query(() => {
    const currencies = CurrencyCode.options.map((code) => ({
      code,
      name: getCurrencyName(code),
      symbol: getCurrencySymbol(code),
    }));

    return currencies.sort((a, b) => a.name.localeCompare(b.name));
  }),
});

// Helper functions for currency support
function getCurrencyName(code: string): string {
  const names: Record<string, string> = {
    USD: 'US Dollar',
    EUR: 'Euro',
    GBP: 'British Pound Sterling',
    JPY: 'Japanese Yen',
    CHF: 'Swiss Franc',
    CAD: 'Canadian Dollar',
    AUD: 'Australian Dollar',
    CNY: 'Chinese Yuan',
    INR: 'Indian Rupee',
    BRL: 'Brazilian Real',
    KRW: 'South Korean Won',
    SEK: 'Swedish Krona',
    NOK: 'Norwegian Krone',
    DKK: 'Danish Krone',
    PLN: 'Polish Złoty',
    CZK: 'Czech Koruna',
    HUF: 'Hungarian Forint',
    RUB: 'Russian Ruble',
    MXN: 'Mexican Peso',
    ZAR: 'South African Rand',
    SGD: 'Singapore Dollar',
    HKD: 'Hong Kong Dollar',
    NZD: 'New Zealand Dollar',
    TRY: 'Turkish Lira',
    THB: 'Thai Baht',
    MYR: 'Malaysian Ringgit',
    IDR: 'Indonesian Rupiah',
    PHP: 'Philippine Peso',
    VND: 'Vietnamese Dong',
    AED: 'UAE Dirham',
    SAR: 'Saudi Riyal',
    ILS: 'Israeli Shekel',
    EGP: 'Egyptian Pound',
  };
  return names[code] || code;
}

function getCurrencySymbol(code: string): string {
  const symbols: Record<string, string> = {
    USD: '$',
    EUR: '€',
    GBP: '£',
    JPY: '¥',
    CHF: 'CHF',
    CAD: 'C$',
    AUD: 'A$',
    CNY: '¥',
    INR: '₹',
    BRL: 'R$',
    KRW: '₩',
    SEK: 'kr',
    NOK: 'kr',
    DKK: 'kr',
    PLN: 'zł',
    CZK: 'Kč',
    HUF: 'Ft',
    RUB: '₽',
    MXN: '$',
    ZAR: 'R',
    SGD: 'S$',
    HKD: 'HK$',
    NZD: 'NZ$',
    TRY: '₺',
    THB: '฿',
    MYR: 'RM',
    IDR: 'Rp',
    PHP: '₱',
    VND: '₫',
    AED: 'د.إ',
    SAR: 'ر.س',
    ILS: '₪',
    EGP: 'E£',
  };
  return symbols[code] || code;
}
