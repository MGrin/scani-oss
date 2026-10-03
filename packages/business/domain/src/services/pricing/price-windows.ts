/**
 * How far a price's time may sit from the moment asked for and still count as
 * live: `PricingService` serves a stored price that young without a provider
 * call, and `PricingProviderAdapter` asks a provider for a current rather than
 * a historical price inside it. The only definition; the two used to keep
 * separate copies in step by comment.
 */
export const LIVE_PRICE_WINDOW_MS = 60 * 60 * 1000;
