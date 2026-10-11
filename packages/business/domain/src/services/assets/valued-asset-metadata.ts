import { type ValuedAssetDetails, ValuedAssetDetailsDto } from '@scani/shared';

/** What a valued asset's token keeps in `provider_metadata.valuedAsset` (SC-1643). */
export interface ValuedAssetRecord {
  details: ValuedAssetDetails;
  purchaseDate: string;
  purchasePrice: string;
  currencyCode: string;
}

const VALUED_ASSET_METADATA_KEY = 'valuedAsset';

export function valuedAssetMetadata(record: ValuedAssetRecord): Record<string, unknown> {
  return { [VALUED_ASSET_METADATA_KEY]: record };
}

/** The record, or null for a token that is not a valued asset or carries a malformed one. */
export function readValuedAsset(metadata: unknown): ValuedAssetRecord | null {
  const raw = (metadata as Record<string, unknown> | null)?.[VALUED_ASSET_METADATA_KEY] as
    | Partial<ValuedAssetRecord>
    | undefined;
  if (!raw) return null;
  const details = ValuedAssetDetailsDto.safeParse(raw.details);
  const { purchaseDate, purchasePrice, currencyCode } = raw;
  if (!details.success || typeof purchaseDate !== 'string') return null;
  if (typeof purchasePrice !== 'string' || typeof currencyCode !== 'string') return null;
  return { details: details.data, purchaseDate, purchasePrice, currencyCode };
}
