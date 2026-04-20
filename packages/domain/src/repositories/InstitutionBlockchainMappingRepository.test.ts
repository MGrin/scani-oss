import { describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { withTestDb } from '../../test/helpers/db';
import { makeInstitution } from '../../test/helpers/factories';
import { InstitutionBlockchainMappingRepository } from './InstitutionBlockchainMappingRepository';

// InstitutionBlockchainMappingRepository is the small table that powers
// `IntegrationManager.detectWalletInstitutions` (wallet-import). If this
// query returns 0 rows, every wallet-import silently does nothing — which
// was exactly the regression behind the `BlockchainServiceManager` vs
// `IntegrationManager` split. Pin the lookup paths.

const repo = () => Container.get(InstitutionBlockchainMappingRepository);

describe('InstitutionBlockchainMappingRepository', () => {
  test('findByInstitutionId returns the mapping for that institution', async () => {
    await withTestDb(async (tx) => {
      const institution = await makeInstitution(tx);
      await repo().create(
        {
          institutionId: institution.id,
          chainId: '1',
          chainType: 'evm',
        },
        tx
      );
      const found = await repo().findByInstitutionId(institution.id, tx);
      expect(found?.chainId).toBe('1');
      expect(found?.chainType).toBe('evm');
    });
  });

  test('findByInstitutionId returns null for unmapped institutions', async () => {
    await withTestDb(async (tx) => {
      const institution = await makeInstitution(tx);
      expect(await repo().findByInstitutionId(institution.id, tx)).toBeNull();
    });
  });

  test('findByChainId resolves by chainId (wallet-import reverse lookup)', async () => {
    await withTestDb(async (tx) => {
      const institution = await makeInstitution(tx);
      await repo().create(
        { institutionId: institution.id, chainId: 'solana', chainType: 'solana' },
        tx
      );
      const found = await repo().findByChainId('solana', tx);
      expect(found?.institutionId).toBe(institution.id);
    });
  });

  test('findAllActive excludes deactivated mappings', async () => {
    await withTestDb(async (tx) => {
      const active = await makeInstitution(tx);
      const deactivated = await makeInstitution(tx);
      await repo().create(
        { institutionId: active.id, chainId: 'bitcoin', chainType: 'bitcoin' },
        tx
      );
      await repo().create(
        {
          institutionId: deactivated.id,
          chainId: 'tron',
          chainType: 'tron',
          isActive: false,
        },
        tx
      );
      const rows = await repo().findAllActive(tx);
      const institutionIds = rows.map((r) => r.institutionId);
      expect(institutionIds).toContain(active.id);
      expect(institutionIds).not.toContain(deactivated.id);
    });
  });
});
