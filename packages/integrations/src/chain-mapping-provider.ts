/**
 * Interface that the IntegrationManager uses to resolve institution ↔
 * chain mappings without reaching into `@scani/domain` for a repository.
 *
 * Background: the manager needs a small set of DB-backed lookups (which
 * chainId a given institution maps to, and the reverse), but it lives
 * one layer below the domain in the package graph. Importing
 * `InstitutionBlockchainMappingRepository` directly was a layer leak —
 * integrations is meant to be a pure adapter package that domain
 * consumes, not the other way around.
 *
 * Contract: the domain side registers a TypeDI binding for
 * `CHAIN_MAPPING_PROVIDER` pointing at the repository. The manager pulls
 * it via `Container.get(CHAIN_MAPPING_PROVIDER)`. Interchange shape is
 * the minimum surface the manager actually needs — the repository's
 * wider API (inserts, updates) stays private to the domain.
 */

export interface ChainMappingRecord {
  institutionId: string;
  chainId: string;
  chainType: string;
  isActive: boolean;
}

export interface IChainMappingProvider {
  findByChainId(chainId: string): Promise<ChainMappingRecord | null>;
  findByInstitutionId(institutionId: string): Promise<ChainMappingRecord | null>;
  findAllActive(): Promise<ChainMappingRecord[]>;
}

/**
 * TypeDI service identifier for the chain-mapping provider.
 *
 * STRING, not `new Token<T>()`. Reason: TypeDI's `Token` uses object
 * identity for Map lookups. When this module is pulled into two
 * independent module instances (bundled copy vs source copy, worktree
 * symlink vs realpath, etc.) each call to `new Token('X')` produces a
 * DIFFERENT identity with the same name — so `Container.set(TokenA, v)`
 * and `Container.get(TokenB)` miss each other even though both claim
 * the name `'ChainMappingProvider'`. A string identifier is compared
 * by value, so the worker/backend always resolve the same binding
 * regardless of how many times the module loads.
 *
 * The silent failure mode this prevents: `detectWalletInstitutions`
 * returning `[]` after chain detection succeeded on 6 chains,
 * surfacing in logs as `No institutions detected for wallet`.
 */
export const CHAIN_MAPPING_PROVIDER = 'chain-mapping-provider' as const;
