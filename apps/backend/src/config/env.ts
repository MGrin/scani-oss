import { z } from 'zod';

/**
 * Startup environment validation for the backend service.
 *
 * This schema is parsed once at boot. Missing or malformed environment
 * variables cause the process to exit with a clear error listing every
 * failing variable, instead of producing obscure runtime errors later.
 */

const isProduction = process.env.NODE_ENV === 'production';

const urlSchema = z.string().url({ message: 'must be a valid URL' });

const httpsUrlInProduction = isProduction
  ? urlSchema.refine((v) => v.startsWith('https://'), {
      message: 'must use https:// in production',
    })
  : urlSchema;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z
    .string()
    .optional()
    .transform((v) => (v ? Number.parseInt(v, 10) : 3001))
    .refine((n) => Number.isFinite(n) && n > 0 && n < 65536, {
      message: 'PORT must be a valid port number',
    }),
  HOST: z.string().default('localhost'),

  // Database
  DATABASE_URL: urlSchema,

  // Supabase auth
  SUPABASE_URL: urlSchema,
  SUPABASE_ANON_KEY: z.string().min(1, { message: 'SUPABASE_ANON_KEY is required' }),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // Frontend origin for CORS. Required in production, must be https://.
  FRONTEND_URL: isProduction ? httpsUrlInProduction : urlSchema.default('http://localhost:5173'),

  // Credential encryption key. Required in production (never let the
  // encryption module silently fall back to plaintext).
  ENCRYPTION_KEY: isProduction
    ? z.string().min(32, { message: 'ENCRYPTION_KEY must be at least 32 chars in production' })
    : z.string().optional(),

  // Optional services
  OPENAI_API_KEY: z.string().optional(),
  COINGECKO_API_KEY: z.string().optional(),
  FINNHUB_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    // Intentionally use console.error; logger may not be wired yet at boot.
    // biome-ignore lint/suspicious/noConsole: startup error before logger available
    console.error(
      `\n❌ Invalid environment configuration:\n${issues}\n\n` +
        `Fix the above variables in your environment or .env file and restart.`
    );
    process.exit(1);
  }

  cached = parsed.data;
  return cached;
}
