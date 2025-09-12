import { z } from "zod";

// =============================================================================
// ENUMS & CONSTANTS
// =============================================================================

// Institution types - Now dynamic, fetched from database
// Note: For UI-specific features like icons/colors, use the institution type code
// but keep these as minimal as possible and fetch types from the API
export const InstitutionTypeSchema = z
  .string()
  .min(1, "Institution type is required");

// Account types - Now dynamic, fetched from database
// Note: For UI-specific features like icons/colors, use the account type code
// but keep these as minimal as possible and fetch types from the API
export const AccountTypeSchema = z.string().min(1, "Account type is required");

// Transaction types
export const TransactionType = z.enum([
  "deposit", // Money in
  "withdrawal", // Money out
  "transfer", // Between accounts
  "buy", // Purchase asset
  "sell", // Sell asset
  "dividend", // Dividend payment
  "interest", // Interest earned
  "fee", // Fee payment
  "other",
]);

// Token types - now dynamic, fetched from database
export const TokenTypeSchema = z.string().min(1, "Token type is required");

// =============================================================================
// CORE SCHEMAS
// =============================================================================

// User schema
export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().min(1, "Name cannot be empty"),
  avatar: z.string().optional(),
  baseCurrencyId: z.string().uuid().nullable(),
  baseCurrency: z
    .object({
      id: z.string(),
      symbol: z.string(),
      name: z.string(),
    })
    .nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Token schema - represents any tradeable asset
export const TokenSchema = z.object({
  id: z.string(),
  symbol: z.string().min(1, "Symbol cannot be empty"), // BTC, EUR, AAPL, etc.
  name: z.string().min(1, "Name cannot be empty"), // Bitcoin, US Dollar, Apple Inc., etc.
  type: TokenTypeSchema,
  decimals: z.number().int().min(0).max(18).default(2), // Precision
  iconUrl: z.string().optional(),
  isActive: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Enhanced name validation helper with comprehensive checks
const createNameValidation = (
  entityType: string,
  maxLength = 50,
  allowSpecialChars = false
) =>
  z
    .string()
    .trim()
    .min(1, `${entityType} name cannot be empty`)
    .max(
      maxLength,
      `${entityType} name must be at most ${maxLength} characters`
    )
    .refine(
      (val) => val.trim().length > 0,
      `${entityType} name cannot contain only whitespace`
    )
    .refine(
      (val) => !/^\s*$/.test(val),
      `${entityType} name cannot be blank or whitespace only`
    )
    .refine(
      (val) =>
        allowSpecialChars
          ? /^[\x20-\x7E]+$/.test(val)
          : /^[a-zA-Z0-9\s\-_.,()&']+$/.test(val),
      allowSpecialChars
        ? `${entityType} name must contain only printable characters`
        : `${entityType} name can only contain letters, numbers, spaces, and common punctuation`
    )
    .refine((val) => {
      // Check for control characters (char codes 0-31 and 127)
      for (let i = 0; i < val.length; i++) {
        const code = val.charCodeAt(i);
        if ((code >= 0 && code <= 31) || code === 127) {
          return false;
        }
      }
      return true;
    }, `${entityType} name cannot contain control characters`)
    .refine(
      (val) => val.trim() === val,
      `${entityType} name cannot start or end with whitespace`
    )
    .transform((val) => val.trim());

// Institution name validation helper
const trimmedNonEmptyString = createNameValidation("Institution", 50, true);

// Enhanced website validation helper with comprehensive URL checking
const websiteValidation = z
  .string()
  .trim()
  .max(500, "Website URL must be at most 500 characters")
  .refine((val) => {
    if (!val || val === "") return true;
    // Must start with http:// or https://
    return /^https?:\/\/.+/i.test(val);
  }, "Website URL must start with http:// or https://")
  .refine((val) => {
    if (!val || val === "") return true;
    try {
      const url = new URL(val);
      // Check for valid domain structure
      return /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?(?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?)*$/.test(
        url.hostname
      );
    } catch {
      return false;
    }
  }, "Please enter a valid website URL")
  .refine((val) => {
    if (!val || val === "") return true;
    // Prevent localhost, private IPs, and suspicious domains
    const suspiciousPatterns = [
      /localhost/i,
      /127\.0\.0\.1/,
      /192\.168\./,
      /10\./,
      /172\.(1[6-9]|2[0-9]|3[01])\./,
      /file:\/\//i,
      /javascript:/i,
      /data:/i,
    ];
    return !suspiciousPatterns.some((pattern) => pattern.test(val));
  }, "Website URL appears to be invalid or suspicious")
  .optional()
  .or(z.literal(""));

// Description validation helper
const descriptionValidation = z
  .string()
  .max(300, "Description must be at most 300 characters")
  .optional();

// Institution schema
export const InstitutionSchema = z.object({
  id: z.string(),
  userId: z.string().min(1, "User ID cannot be empty"),
  name: trimmedNonEmptyString,
  type: InstitutionTypeSchema,
  description: descriptionValidation,
  website: websiteValidation,
  logoUrl: z.string().optional(),
  isActive: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Account name validation helper
const accountNameValidation = createNameValidation("Account", 100, false);

// Account description validation helper
const accountDescriptionValidation = z
  .string()
  .max(500, "Description must be at most 500 characters")
  .optional()
  .or(z.literal(""));

// Account schema
export const AccountSchema = z.object({
  id: z.string(),
  institutionId: z.string().min(1, "Institution ID cannot be empty"),
  name: accountNameValidation,
  type: AccountTypeSchema,
  description: accountDescriptionValidation,
  isActive: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// Enhanced monetary validation helper - now returns string-based validation for Decimal.js compatibility
const createMonetaryValidation = (
  fieldName: string,
  {
    allowNegative = false,
    minValue = "-1000000000000000", // 1e15 as string
    maxValue = "1000000000000000", // 1e15 as string
    maxDecimals = 18,
    required = true,
  } = {}
) => {
  const baseSchema = z
    .string({
      invalid_type_error: `${fieldName} must be a valid decimal string`,
      required_error: required ? `${fieldName} is required` : undefined,
    })
    .refine((val) => {
      // Check if it's a valid number format
      const num = parseFloat(val);
      return !Number.isNaN(num) && Number.isFinite(num);
    }, `${fieldName} must be a valid decimal number`)
    .refine((val) => {
      const num = parseFloat(val);
      return num >= parseFloat(minValue);
    }, `${fieldName} must be at least ${minValue}`)
    .refine((val) => {
      const num = parseFloat(val);
      return num <= parseFloat(maxValue);
    }, `${fieldName} cannot exceed ${maxValue}`)
    .refine((val) => {
      // Check decimal places
      const decimalPlaces = (val.split(".")[1] || "").length;
      return decimalPlaces <= maxDecimals;
    }, `${fieldName} cannot have more than ${maxDecimals} decimal places`);

  const schemaWithNegative = allowNegative
    ? baseSchema
    : baseSchema.refine((val) => {
        const num = parseFloat(val);
        return num >= 0;
      }, `${fieldName} cannot be negative`);

  return required ? schemaWithNegative : schemaWithNegative.optional();
};

// TokenPrice schema - historical prices
export const TokenPriceSchema = z.object({
  id: z.string(),
  tokenId: z.string(),
  baseTokenId: z.string(), // Usually a fiat currency
  price: createMonetaryValidation("Price", { allowNegative: false }),
  timestamp: z.date(),
  source: z.string().optional(), // 'coinbase', 'yahoo', etc.
  createdAt: z.date(),
});

// Holding schema - represents a specific token balance in an account
export const HoldingSchema = z.object({
  id: z.string(),
  accountId: z.string().min(1, "Account ID cannot be empty"),
  tokenId: z.string().min(1, "Token ID cannot be empty"),
  balance: createMonetaryValidation("Balance", { allowNegative: true }), // Can be negative for short positions
  lastUpdated: z.date(),
  createdAt: z.date(),
});

// Transaction schema with enhanced monetary validation
export const TransactionSchema = z.object({
  id: z.string(),
  holdingId: z.string(),
  type: TransactionType,
  amount: createMonetaryValidation("Amount", { allowNegative: true }), // Positive or negative based on type
  fee: createMonetaryValidation("Fee", { allowNegative: false }).default("0"),
  feeTokenId: z.string().optional(), // Currency of the fee
  description: z
    .string()
    .trim()
    .max(500, "Description must be at most 500 characters")
    .optional(),
  reference: z
    .string()
    .trim()
    .max(100, "Reference must be at most 100 characters")
    .optional(), // External transaction ID
  timestamp: z.date(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

// =============================================================================
// INPUT SCHEMAS (for API)
// =============================================================================

export const CreateUserSchema = UserSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const CreateTokenSchema = TokenSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const CreateTokenPriceSchema = TokenPriceSchema.omit({
  id: true,
  createdAt: true,
});

export const CreateInstitutionSchema = InstitutionSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const CreateAccountSchema = AccountSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const CreateHoldingSchema = HoldingSchema.omit({
  id: true,
  createdAt: true,
});

export const CreateTransactionSchema = TransactionSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// =============================================================================
// UPDATE SCHEMAS
// =============================================================================

// UpdateUserSchema allows updating only specific fields: name, avatar, baseCurrencyId
export const UpdateUserSchema = z.object({
  name: z.string().min(1, "Name cannot be empty").optional(),
  avatar: z.string().optional(),
  baseCurrencyId: z.string().uuid().optional(),
});
export const UpdateTokenSchema = CreateTokenSchema.partial();
export const UpdateInstitutionSchema = CreateInstitutionSchema.partial();
export const UpdateAccountSchema = CreateAccountSchema.partial();
export const UpdateHoldingSchema = CreateHoldingSchema.partial();
export const UpdateTransactionSchema = CreateTransactionSchema.partial();

// =============================================================================
// TYPESCRIPT TYPES
// =============================================================================

export type User = z.infer<typeof UserSchema>;
export type Token = z.infer<typeof TokenSchema>;
export type TokenPrice = z.infer<typeof TokenPriceSchema>;
export type Institution = z.infer<typeof InstitutionSchema>;
export type Account = z.infer<typeof AccountSchema>;
export type Holding = z.infer<typeof HoldingSchema>;
export type Transaction = z.infer<typeof TransactionSchema>;

export type CreateUser = z.infer<typeof CreateUserSchema>;
export type CreateToken = z.infer<typeof CreateTokenSchema>;
export type CreateTokenPrice = z.infer<typeof CreateTokenPriceSchema>;
export type CreateInstitution = z.infer<typeof CreateInstitutionSchema>;
export type CreateAccount = z.infer<typeof CreateAccountSchema>;
export type CreateHolding = z.infer<typeof CreateHoldingSchema>;
export type CreateTransaction = z.infer<typeof CreateTransactionSchema>;

export type UpdateUser = z.infer<typeof UpdateUserSchema>;
export type UpdateToken = z.infer<typeof UpdateTokenSchema>;
export type UpdateInstitution = z.infer<typeof UpdateInstitutionSchema>;
export type UpdateAccount = z.infer<typeof UpdateAccountSchema>;
export type UpdateHolding = z.infer<typeof UpdateHoldingSchema>;
export type UpdateTransaction = z.infer<typeof UpdateTransactionSchema>;

// =============================================================================
// LEGACY TYPES (for backward compatibility)
// =============================================================================

// Keep the old TransactionCategory for backward compatibility if needed
export const TransactionCategory = z.enum([
  "food",
  "transportation",
  "housing",
  "healthcare",
  "entertainment",
  "shopping",
  "utilities",
  "income",
  "investment",
  "other",
]);

export type TransactionCategoryType = z.infer<typeof TransactionCategory>;
