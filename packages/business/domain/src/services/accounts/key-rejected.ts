export type KeyRejected = {
  providerKey: string | null;
  /** The provider's word for its credential (SC-1732). */
  credentialNoun: 'key' | 'token';
  /** The credential's longest life in days, so a refusal reads as expiry (SC-1733). */
  credentialLifetimeDays: number | null;
};

/**
 * Which institutions' keys were refused, keyed by institution, with the
 * provider whose connect page replaces the key (SC-1686). Joined by name, as
 * `integrations.listAvailable` joins manifests to institutions. An institution
 * with no manifest is still flagged: the owner must still be told.
 */
export function keyRejectedByInstitution(
  rejected: ReadonlyArray<{ institutionId: string; institutionName: string }>,
  manifests: ReadonlyArray<{
    institutionName: string;
    providerKey: string;
    credentialNoun?: 'key' | 'token';
    credentialLifetimeDays?: number;
  }>
): Map<string, KeyRejected> {
  const manifestByName = new Map(manifests.map((m) => [m.institutionName, m]));
  return new Map(
    rejected.map((r) => {
      const manifest = manifestByName.get(r.institutionName);
      return [
        r.institutionId,
        {
          providerKey: manifest?.providerKey ?? null,
          credentialNoun: manifest?.credentialNoun ?? 'key',
          credentialLifetimeDays: manifest?.credentialLifetimeDays ?? null,
        },
      ];
    })
  );
}
