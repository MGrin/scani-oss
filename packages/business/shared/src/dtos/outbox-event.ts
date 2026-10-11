import { z } from 'zod';

/**
 * Live events (feeds foundation §5, SC-1609). Each is written to
 * `outbox_events` in the same transaction as the data it describes, and the
 * dispatcher copies it to the owner's realtime channel.
 *
 * Events carry data, so an open screen can write them into its query cache
 * instead of refetching. Every payload names its version in `v`: a change to
 * a payload's shape is a new version, never an edit, because a client may
 * still be holding a cache built from the old one.
 */

// Exponent form is allowed: the shared Decimal prints dust as `1e-8` and
// large values as `1e+29`, and a writer passes its output as is.
const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/, 'Expected a decimal string');

/** A holding's balance or value moved. Value is in the owner's base currency. */
export const holdingChangedV1Schema = z.object({
  v: z.literal(1),
  holdingId: z.string().uuid(),
  balance: decimalString,
  /** Null when the holding has no price. */
  valueBase: decimalString.nullable(),
  /** When the price behind `valueBase` was observed; null with it. */
  valuePricedAt: z.string().datetime().nullable(),
});

/** The owner's total moved by `delta`, in `baseCurrencyId`. */
export const totalDeltaV1Schema = z.object({
  v: z.literal(1),
  baseCurrencyId: z.string().uuid(),
  delta: decimalString,
});

/**
 * A token was repriced. One event per owner, naming only that owner's
 * holdings of it: a user's channel never carries another user's ids.
 */
export const priceChangedV1Schema = z.object({
  v: z.literal(1),
  tokenId: z.string().uuid(),
  holdingIds: z.array(z.string().uuid()).min(1),
});

export const OUTBOX_EVENT_SCHEMAS = {
  'holding.changed': holdingChangedV1Schema,
  'total.delta': totalDeltaV1Schema,
  'price.changed': priceChangedV1Schema,
} as const;

export type OutboxEventType = keyof typeof OUTBOX_EVENT_SCHEMAS;
export type OutboxEventPayload<T extends OutboxEventType> = z.infer<
  (typeof OUTBOX_EVENT_SCHEMAS)[T]
>;

export const OUTBOX_MESSAGE_TYPE = 'outbox_event';

/**
 * What a client receives. `id` is the outbox row's id: delivery is
 * at-least-once, so a client drops a message whose id it has already applied.
 */
export const outboxMessageSchema = z.object({
  type: z.literal(OUTBOX_MESSAGE_TYPE),
  id: z.string().regex(/^\d+$/),
  event: z.enum(['holding.changed', 'total.delta', 'price.changed']),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
});
export type OutboxMessage = z.infer<typeof outboxMessageSchema>;
