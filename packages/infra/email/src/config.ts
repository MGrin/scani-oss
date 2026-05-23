import { z } from 'zod';

// Env shape owned by this package. Apps that depend on @scani/email don't
// declare these in their own env.ts schemas — they just set the env vars
// and LocalEmailService self-validates on first method call.
//
// All fields are optional: when nothing is set the package falls back to
// LoggingEmailService (stdout). This lets a contributor boot without any
// transport config and still see magic links / OTPs in `docker logs`.
const envSchema = z.object({
  FASTMAIL_API_TOKEN: z.string().optional(),
  SMTP_URL: z.string().optional(),
  // SMTP_FROM accepts either a bare `local@domain` or a display-name wrapper
  // `"Name" <local@domain>`. The Fastmail JMAP transport parses the wrapper
  // and picks the matching identity, so both shapes need to validate.
  SMTP_FROM: z
    .string()
    .refine((v) => /^(?:"[^"]*"\s*<[^>]+@[^>]+>|\S+@\S+)$/.test(v), {
      message: 'SMTP_FROM must be "Name" <email> or a bare email',
    })
    .optional(),
});

export type EmailConfig = z.infer<typeof envSchema>;

let cached: EmailConfig | null = null;

export function loadEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`@scani/email env misconfigured:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEmailConfig(): void {
  cached = null;
}
