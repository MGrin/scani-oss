// Export all repositories for use by other apps in the monorepo.
//
// Side effect on import: wires `InstitutionBlockchainMappingRepository`
// into the `CHAIN_MAPPING_PROVIDER` TypeDI token so `@scani/integrations`
// can pull a chain-mapping lookup without importing from domain (layer
// inversion). The binding has to happen somewhere the domain + app boot
// sequence both touch; this barrel fits the bill.
import { CHAIN_MAPPING_PROVIDER } from '@scani/integrations';
import { Container } from 'typedi';
import { InstitutionBlockchainMappingRepository } from './InstitutionBlockchainMappingRepository';

Container.set(CHAIN_MAPPING_PROVIDER, Container.get(InstitutionBlockchainMappingRepository));

export { BaseRepository } from '@scani/db';
export { AccountRepository } from './AccountRepository';
export {
  AccountTypeRepository,
  InstitutionTypeRepository,
  TokenTypeRepository,
} from './EnumRepositories';
export { GroupRepository } from './GroupRepository';
export { HoldingApyConfigRepository } from './HoldingApyConfigRepository';
export { HoldingRepository } from './HoldingRepository';
export { InstitutionBlockchainMappingRepository } from './InstitutionBlockchainMappingRepository';
export { InstitutionRepository } from './InstitutionRepository';
export type { TokenPriceEditHistoryWithEditor } from './TokenPriceEditHistoryRepository';
export { TokenPriceEditHistoryRepository } from './TokenPriceEditHistoryRepository';
export { TokenPriceRepository } from './TokenPriceRepository';
export { TokenRepository } from './TokenRepository';
export { UserIntegrationCredentialsRepository } from './UserIntegrationCredentialsRepository';
export { UserJobRepository } from './UserJobRepository';
export { UserRepository } from './UserRepository';
export { UserWalletRepository } from './UserWalletRepository';
export { VaultRepository } from './VaultRepository';
