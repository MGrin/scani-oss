/**
 * An object bigger than its reader agreed to hold, or one whose size storage
 * would not state (SC-1345).
 *
 * The name is in the message as well as on the class because on the cloud
 * path this crosses the data-provider as a TRPCError, which keeps the message
 * and drops the class.
 */
export class ObjectTooLargeError extends Error {
  constructor(
    readonly key: string,
    readonly sizeBytes: number | null,
    readonly maxBytes: number
  ) {
    super(
      sizeBytes === null
        ? `ObjectTooLarge: ${key} has no stated size, and the reader allows at most ${maxBytes} bytes`
        : `ObjectTooLarge: ${key} is ${sizeBytes} bytes, over the ${maxBytes}-byte limit`
    );
    this.name = 'ObjectTooLargeError';
  }
}

export function isObjectTooLargeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /\bObjectTooLarge\b/.test(message);
}
