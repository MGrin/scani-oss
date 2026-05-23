// Defaults baked into QueueClient/WorkerClient when callers don't override.
// Can be replaced at QueueClient.configure() time — the package itself
// has no opinion about naming, only sane scani-specific defaults.
export const DEFAULT_QUEUE_NAME = 'scani-jobs';
export const DEFAULT_DLQ_NAME = 'scani-dlq';
