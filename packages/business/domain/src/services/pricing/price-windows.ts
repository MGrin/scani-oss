/**
 * How far a price's time may sit from the moment asked for and still count as
 * live: `PricingService` serves the import warm-up, the refresh button and a
 * vault a stored price that young without a provider call, and
 * `PricingProviderAdapter` asks a provider for a current rather than a
 * historical price inside it. The hourly run is served no stored price at
 * all. The only definition; the two used to keep separate copies in step by
 * comment.
 */
export const LIVE_PRICE_WINDOW_MS = 60 * 60 * 1000;

/**
 * "Current" for the quarter-hour run over what open apps show (SC-1602).
 * Shorter than its 15-minute schedule on purpose: an answer is stamped when it
 * arrives, a few seconds into a run, so a 15-minute window would still call it
 * current at the next run and skip every other one.
 */
export const ACTIVE_PRICE_WINDOW_MS = 14 * 60 * 1000;
