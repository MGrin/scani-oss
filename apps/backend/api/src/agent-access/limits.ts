/**
 * The two agent budgets, in one place so the limiters and the published
 * reference cannot state different numbers (SC-1648).
 */

/** Per token, across `/mcp` and `/api/v1`. */
export const AGENT_REQUESTS_PER_MINUTE = 120;

/** Per user, for the heavy reads only (SC-1671). */
export const AGENT_HEAVY_READS_PER_MINUTE = 12;
