import { z } from 'zod';

/**
 * Env shape owned by this package (SC-226). Apps that depend on `@scani/push`
 * do not redeclare these in their own `env.ts` — they set the variables and
 * this loader validates them on first use.
 *
 * **Optional in production too, deliberately — and this is the one place the
 * repo's `requiredInProd` convention is not followed.** Every other package
 * makes its secret mandatory in prod so a misconfiguration is a boot failure
 * rather than a runtime one, and that is right when the package is on the
 * critical path. Push is not: the api and worker have shipped without these
 * keys since before push existed, so `requiredInProd` here would take the
 * whole api down on the deploy that introduced a feature nobody had enabled
 * yet.
 *
 * The cost of that choice is the failure mode this repo cares most about —
 * silence that looks like success — so it is bought back explicitly:
 * `PushSender.isConfigured()` is false, the api's `push.publicKey` answers
 * `null`, the Settings toggle says the server cannot send notifications
 * instead of rendering an enabled switch, and the reminder job logs a warn
 * naming the missing variables on every fire it skips for this reason. An
 * operator sees a refusal, never an empty result.
 */
const envSchema = z.object({
  /** VAPID application-server public key, base64url, 65 raw bytes → 87 chars. */
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  /** VAPID application-server private key, base64url, 32 raw bytes → 43 chars. */
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  /**
   * RFC 8292 §2.1: the `sub` claim identifying who to contact about this
   * application server. Push services reject anything that is not a `mailto:`
   * or `https:` URL, so validate it here rather than discovering it in a 400
   * from FCM.
   */
  VAPID_SUBJECT: z
    .string()
    .refine((v) => v.startsWith('mailto:') || v.startsWith('https://'), {
      message: 'VAPID_SUBJECT must be a mailto: or https:// URL (RFC 8292 §2.1)',
    })
    .optional(),
});

export type PushConfig = z.infer<typeof envSchema>;

let cached: PushConfig | null = null;

export function loadPushConfig(env: NodeJS.ProcessEnv = process.env): PushConfig {
  if (cached) return cached;
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`@scani/push env misconfigured:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetPushConfig(): void {
  cached = null;
}

/** The three variables a send needs, or the names of the ones that are missing. */
export type VapidResolution =
  | { ok: true; details: { subject: string; publicKey: string; privateKey: string } }
  | { ok: false; missing: string[] };

/**
 * All three or nothing.
 *
 * A partial configuration is the dangerous shape: a public key with no private
 * key lets the browser subscribe successfully and stores an endpoint we can
 * never send to, so the user is told notifications are on and hears nothing
 * again. Reporting exactly which names are absent is what lets every caller
 * say so out loud instead of returning an empty result.
 */
export function resolveVapid(env: NodeJS.ProcessEnv = process.env): VapidResolution {
  const config = loadPushConfig(env);
  const missing: string[] = [];
  if (!config.VAPID_SUBJECT) missing.push('VAPID_SUBJECT');
  if (!config.VAPID_PUBLIC_KEY) missing.push('VAPID_PUBLIC_KEY');
  if (!config.VAPID_PRIVATE_KEY) missing.push('VAPID_PRIVATE_KEY');
  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    details: {
      subject: config.VAPID_SUBJECT as string,
      publicKey: config.VAPID_PUBLIC_KEY as string,
      privateKey: config.VAPID_PRIVATE_KEY as string,
    },
  };
}
