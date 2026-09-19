/**
 * Salt Edge's callbacks (SC-1244): success, fail, notify, destroy and consent,
 * each POSTed with a `Signature` over `callback_url|raw_body`.
 *
 * Same raw-body route shape as `billing/webhook-routes.ts`, for the same
 * reason: the signature is over bytes, so the route claims its own parse step
 * and the handler sees exactly what was signed. The handler is a function of
 * its inputs so it can be tested without Elysia.
 *
 * It only records and enqueues. The import itself runs on the worker.
 */

import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { SaltEdgeConnectionService } from '@scani/domain/services/integrations/SaltEdgeConnectionService';
import { EXCHANGE_IMPORT } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import {
  parseSaltEdgeCallback,
  verifySaltEdgeCallback,
} from '@scani/providers/providers/saltedge/callback';
import { BullMqEnqueueService } from '@scani/queue';
import { eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { parseAdminRawBody } from '../presentation/http/admin-common';

const logger = createComponentLogger('saltedge-callbacks');

const KINDS = ['success', 'fail', 'notify', 'destroy', 'consent'] as const;
type Kind = (typeof KINDS)[number];

interface CallbackInput {
  kind: string;
  rawBody: unknown;
  signature: string | undefined;
}

interface CallbackDeps {
  publicKeyPem: string;
  /** The public origin Salt Edge was given, which is what it signs. */
  callbackBaseUrl: string;
  applyCallback: SaltEdgeConnectionService['applyCallback'];
  enqueueImport: (userId: string, connectionId: string) => Promise<void>;
}

interface CallbackReply {
  status: number;
  body: Record<string, unknown>;
}

export async function handleSaltEdgeCallback(
  input: CallbackInput,
  deps: CallbackDeps
): Promise<CallbackReply> {
  if (!(KINDS as readonly string[]).includes(input.kind)) {
    return { status: 404, body: { error: 'Not Found' } };
  }
  const kind = input.kind as Kind;

  if (typeof input.rawBody !== 'string') {
    // The signed bytes are gone (`ADMIN_BODY_UNREADABLE`, a symbol). Verifying the empty string would reject every
    // real callback and accept an empty forged one.
    return { status: 400, body: { error: 'Bad Request' } };
  }

  const callbackUrl = `${deps.callbackBaseUrl}/webhooks/saltedge/${kind}`;
  if (
    !verifySaltEdgeCallback(callbackUrl, input.rawBody, input.signature ?? '', deps.publicKeyPem)
  ) {
    logger.warn({ kind }, 'Rejected a Salt Edge callback: bad signature');
    return { status: 401, body: { error: 'Unauthorized' } };
  }

  const data = parseSaltEdgeCallback(input.rawBody);
  if (!data) {
    // Verified but not actionable. A redelivery would carry the same payload,
    // so it is acknowledged and logged rather than refused.
    logger.warn({ kind }, 'Salt Edge callback verified but missing its ids');
    return { status: 200, body: { received: true, applied: false } };
  }

  try {
    const outcome = await deps.applyCallback(kind, data);
    if (outcome.kind === 'applied' && outcome.importNeeded) {
      await deps.enqueueImport(outcome.userId, data.connectionId);
    }
    logger.info(
      { kind, connectionId: data.connectionId, outcome: outcome.kind },
      'Applied a Salt Edge callback'
    );
    return { status: 200, body: { received: true, applied: outcome.kind === 'applied' } };
  } catch (error) {
    // The signature was good and our side failed: 500 makes Salt Edge redeliver.
    logger.error(
      {
        kind,
        connectionId: data.connectionId,
        error: error instanceof Error ? error.message : String(error),
      },
      'Salt Edge callback verified but could not be applied'
    );
    return { status: 500, body: { error: 'Internal Server Error' } };
  }
}

async function enqueueImport(userId: string, connectionId: string): Promise<void> {
  const [institution] = await db
    .select({ id: schema.institutions.id })
    .from(schema.institutions)
    .where(eq(schema.institutions.name, 'Salt Edge'))
    .limit(1);
  if (!institution) throw new Error('Institution "Salt Edge" is not seeded');
  await Container.get(BullMqEnqueueService).add(EXCHANGE_IMPORT, {
    userId,
    requestId: `saltedge-${connectionId}-${Date.now()}`,
    institutionId: institution.id,
    provider: 'Salt Edge',
  });
}

export function registerSaltEdgeCallbackRoutes(
  // biome-ignore lint/suspicious/noExplicitAny: Elysia accumulates route types; match whatever shape the caller has.
  app: any,
  env: { SALTEDGE_CALLBACK_PUBLIC_KEY?: string; BACKEND_URL: string }
): void {
  const publicKeyPem = env.SALTEDGE_CALLBACK_PUBLIC_KEY;
  if (!publicKeyPem) {
    // Said out loud: an unmounted route is a 404, which from Salt Edge's side
    // looks exactly like a mistyped callback URL.
    logger.warn({}, 'SALTEDGE_CALLBACK_PUBLIC_KEY is unset — Salt Edge callbacks are not mounted');
    return;
  }
  const service = Container.get(SaltEdgeConnectionService);
  app.post(
    '/webhooks/saltedge/:kind',
    // biome-ignore lint/suspicious/noExplicitAny: Elysia handler ctx types are dynamic
    async ({ params, headers, body, set }: any) => {
      const reply = await handleSaltEdgeCallback(
        { kind: params.kind, rawBody: body, signature: headers?.signature },
        {
          publicKeyPem,
          callbackBaseUrl: env.BACKEND_URL.replace(/\/$/, ''),
          applyCallback: (kind, data) => service.applyCallback(kind, data),
          enqueueImport,
        }
      );
      set.status = reply.status;
      return reply.body;
    },
    { parse: parseAdminRawBody }
  );
  logger.info({}, 'Salt Edge callbacks mounted');
}
