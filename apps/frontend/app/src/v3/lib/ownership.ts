/**
 * The bucket every account nobody has classified falls into (SC-463).
 *
 * Re-exported from the wire contract rather than spelled again, so the client
 * and the server cannot disagree about the one string that distinguishes "not
 * in any set of books" from an entity id.
 */
export { UNASSIGNED_ENTITY } from '@scani/shared';
