export type KeyRejected = { providerKey: string | null };

/**
 * Which institutions' keys were refused, keyed by institution, with the
 * provider whose connect page replaces the key (SC-1686). Joined by name, as
 * `integrations.listAvailable` joins manifests to institutions. An institution
 * with no manifest is still flagged: the owner must still be told.
 */
export function keyRejectedByInstitution(
  rejected: ReadonlyArray<{ institutionId: string; institutionName: string }>,
  manifests: ReadonlyArray<{ institutionName: string; providerKey: string }>
): Map<string, KeyRejected> {
  const providerKeyByName = new Map(manifests.map((m) => [m.institutionName, m.providerKey]));
  return new Map(
    rejected.map((r) => [
      r.institutionId,
      { providerKey: providerKeyByName.get(r.institutionName) ?? null },
    ])
  );
}
