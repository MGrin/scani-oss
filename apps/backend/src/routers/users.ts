import { CurrencyCode, UpdateUserSchema } from '@scani/shared/types';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { getDbUser, getUserId } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

export const usersRouter = router({
  // Get current authenticated user
  getCurrent: protectedProcedure.query(async ({ ctx }) => {
    const user = getDbUser(ctx);
    return user;
  }),

  // Get all users
  getAll: protectedProcedure.query(async () => {
    const users = await db.select().from(schema.users).orderBy(schema.users.name);
    return users;
  }),

  // Get user by ID
  getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const [user] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, input.id))
      .limit(1);

    if (!user) {
      throw new Error('User not found');
    }
    return user;
  }),

  // Update current user
  updateCurrent: protectedProcedure.input(UpdateUserSchema).mutation(async ({ input, ctx }) => {
    const userId = getUserId(ctx);

    const [updatedUser] = await db
      .update(schema.users)
      .set({
        ...input,
        updatedAt: new Date(),
      })
      .where(eq(schema.users.id, userId))
      .returning();

    if (!updatedUser) {
      throw new Error('User not found');
    }

    return updatedUser;
  }),

  // Delete user
  delete: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const [deletedUser] = await db
      .delete(schema.users)
      .where(eq(schema.users.id, input.id))
      .returning();

    if (!deletedUser) {
      throw new Error('User not found');
    }

    return { success: true, deleted: deletedUser };
  }),

  // Get supported currencies
  getSupportedCurrencies: protectedProcedure.query(() => {
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
