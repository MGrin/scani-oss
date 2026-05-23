import { createComponentLogger } from '@scani/logging';

const logger = createComponentLogger('use-case:safeStatus');

/**
 * Best-effort wrapper around an `onStatus` sink. Use cases call this
 * to surface phase messages to the BullMQ JobHeader, but a flaky sink
 * (Redis publish failure, processor disconnect) must never abort the
 * import mid-flight.
 *
 * The sink is optional — every long-running use case takes a `?`-typed
 * callback so unit tests + non-job callers can run without wiring one.
 */
export async function safeStatus(
  onStatus: ((message: string) => void | Promise<void>) | undefined,
  message: string
): Promise<void> {
  if (!onStatus) return;
  try {
    await onStatus(message);
  } catch (err) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err), message },
      'onStatus sink threw — ignoring'
    );
  }
}
