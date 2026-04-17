import { z } from 'zod';

/**
 * Startup environment validation for the cron runner.
 *
 * Parsed once at boot. Fails fast with an explicit list of missing or
 * malformed variables instead of producing obscure runtime errors mid-job.
 */

const isProduction = process.env.NODE_ENV === 'production';

const urlSchema = z.string().url({ message: 'must be a valid URL' });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: urlSchema,

  SUPABASE_URL: urlSchema,
  SUPABASE_ANON_KEY: z.string().min(1, { message: 'SUPABASE_ANON_KEY is required' }),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // Credential encryption key. Required in production.
  ENCRYPTION_KEY: isProduction
    ? z.string().min(32, { message: 'ENCRYPTION_KEY must be at least 32 chars in production' })
    : z.string().optional(),

  // Optional integration keys
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
    console.error(
      `\n❌ Invalid environment configuration:\n${issues}\n\n` +
        `Fix the above variables in your environment or .env file and restart.`
    );
    process.exit(1);
  }

  cached = parsed.data;
  return cached;
}
