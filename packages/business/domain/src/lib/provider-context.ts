import type { ProviderContext } from '@scani/providers/core/types';

// Synthetic USD token used as `baseCurrency` for self-credentialed
// balance / account-discovery calls. The provider never persists this
// row — it satisfies the type contract while the orchestrator owns the
// real base-currency mapping downstream.
const SYNTHETIC_BASE_CURRENCY: ProviderContext['baseCurrency'] = {
  id: 'synthetic-usd',
  symbol: 'USD',
  name: 'United States Dollar',
  typeId: 'fiat',
  decimals: 2,
  iconUrl: null,
  providerMetadata: {},
  isScamProbability: 0,
  isActive: true,
  marketSegment: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

export type SelfCredentialedProviderContext = ProviderContext & {
  institutionCode: string;
  credentialsRef: NonNullable<ProviderContext['credentialsRef']>;
  resolveCredentials: NonNullable<ProviderContext['resolveCredentials']>;
};

export function makeProviderContext(input: {
  userId: string;
  institutionId: string;
  institutionCode: string;
  resolveCredentials: () => Promise<Record<string, unknown>>;
}): SelfCredentialedProviderContext {
  return {
    baseCurrency: SYNTHETIC_BASE_CURRENCY,
    timestamp: new Date(),
    userId: input.userId,
    institutionCode: input.institutionCode,
    credentialsRef: { userId: input.userId, institutionId: input.institutionId },
    resolveCredentials: async () =>
      (await input.resolveCredentials()) as Awaited<
        ReturnType<NonNullable<ProviderContext['resolveCredentials']>>
      >,
  };
}
