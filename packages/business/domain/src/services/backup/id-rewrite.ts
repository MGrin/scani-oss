const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * A value with every id the restore re-issued replaced by its new one, at any
 * depth (SC-1649). The ids live in more places than foreign keys: a ledger
 * row's `source_metadata` names the outflow it answers, an arrival's
 * `external_id` is that outflow's id, an APY payout's embeds its config's, and
 * a retired gap answer keeps whole rows as JSON. One rule covers all of them:
 * a UUID the file issued, wherever it appears, becomes the restored row's.
 * A UUID the map does not know, such as a provider's, is left as it is.
 */
export function rewriteIds<T>(value: T, ids: ReadonlyMap<string, string>): T {
  return rewrite(value, ids) as T;
}

function rewrite(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    return value.replace(UUID, (id) => ids.get(id.toLowerCase()) ?? id);
  }
  if (Array.isArray(value)) return value.map((v) => rewrite(v, ids));
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewrite(v, ids)]));
  }
  return value;
}
