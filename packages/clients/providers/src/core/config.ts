import { z } from 'zod';

// Env shape owned by this package. Apps that depend on @scani/providers
// don't redeclare these in their own env.ts schemas — they just set the
// env vars and provider factories read them via `deps.env.<KEY>` from
// the boot factory's pass-through.
//
// Every field is OPTIONAL: providers are conditionally active. A backend
// running in cloud mode (SCANI_CLOUD_URL set) reaches every upstream
// service via the data-provider, so the per-provider keys are only
// required on the data-provider's host.
//
// The schema's job is documentation + a single point of validation —
// it's not a gate. Apps that need a specific key set should call
// `loadProvidersConfig()` and check the returned value, the same way
// they'd check any other optional config field.
const envSchema = z.object({
  // Pricing
  COINGECKO_API_KEY: z.string().optional(),
  FINNHUB_API_KEY: z.string().optional(),

  // Public chains
  ETHERSCAN_API_KEY: z.string().optional(),
  HELIUS_API_KEY: z.string().optional(),

  // AI inference
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_VISION_MODEL: z.string().optional(),

  // Google Sheets (data-provider only)
  GOOGLE_SHEETS_ID: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_KEY: z.string().optional(),

  // Sandbox / testnet base URLs. Optional in every environment; set
  // by per-developer dev configs to point a CEX provider at the
  // venue's sandbox host instead of production. OKX uses a header
  // (`x-simulated-trading: 1`) so its toggle is a literal flag.
  SCANI_TESTNET_BINANCE_BASE_URL: z.string().optional(),
  SCANI_TESTNET_BYBIT_BASE_URL: z.string().optional(),
  SCANI_TESTNET_OKX_SIMULATED: z.string().optional(),
  SCANI_TESTNET_COINBASE_BASE_URL: z.string().optional(),
  SCANI_TESTNET_GEMINI_BASE_URL: z.string().optional(),
  SCANI_TESTNET_WISE_BASE_URL: z.string().optional(),
});

export type ProvidersConfig = z.infer<typeof envSchema>;

let cached: ProvidersConfig | null = null;

export function loadProvidersConfig(env: NodeJS.ProcessEnv = process.env): ProvidersConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`@scani/providers env misconfigured:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetProvidersConfig(): void {
  cached = null;
}
