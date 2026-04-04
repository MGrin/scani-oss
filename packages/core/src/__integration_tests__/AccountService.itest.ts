import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock database connection (BaseService imports getDb)
// Note: DATABASE_URL must be set before bun loads modules - use test-preload.ts
mock.module('../database/connection', () => ({
  db: {},
  getDb: () => ({}),
}));

// Mock repositories
const mockAccountRepository = {
  findById: mock(() => Promise.resolve(null)),
  findByUser: mock(() => Promise.resolve([])),
  create: mock(() => Promise.resolve(null)),
  delete: mock(() => Promise.resolve(false)),
  updateAccount: mock(() => Promise.resolve(null)),
  findWalletAccounts: mock(() => Promise.resolve([])),
  updateMetadata: mock(() => Promise.resolve()),
};

const mockInstitutionRepository = {
  findById: mock(() => Promise.resolve(null)),
};

const mockAccountTypeRepository = {
  findById: mock(() => Promise.resolve(null)),
};

const mockHoldingRepository = {
  findByUser: mock(() => Promise.resolve([])),
};

const mockTokenRepository = {
  findByIds: mock(() => Promise.resolve([])),
};

const mockGroupRepository = {
  findGroupsForAccounts: mock(() => Promise.resolve(new Map())),
};

const mockUserWalletService = {
  removeInstitutionFromWallet: mock(() => Promise.resolve()),
};

const mockPortfolioService = {
  getUserPortfolioValue: mock(() => Promise.resolve({ holdings: [], totalValue: '0' })),
};

mock.module('typedi', () => ({
  Container: {
    get: (cls: { name?: string }) => {
      const name = cls?.name || '';
      if (name.includes('AccountRepository')) return mockAccountRepository;
      if (name.includes('InstitutionRepository')) return mockInstitutionRepository;
      if (name.includes('AccountTypeRepository')) return mockAccountTypeRepository;
      if (name.includes('HoldingRepository')) return mockHoldingRepository;
      if (name.includes('TokenRepository')) return mockTokenRepository;
      if (name.includes('GroupRepository')) return mockGroupRepository;
      if (name.includes('UserWalletService')) return mockUserWalletService;
      if (name.includes('PortfolioValuationService')) return mockPortfolioService;
      return {};
    },
  },
  Service: () => (target: unknown) => target,
}));

mock.module('../utils/logger', () => ({
  createComponentLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
  logger: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
}));

import { AccountService } from './AccountService';

describe('AccountService', () => {
  let service: AccountService;

  const mockAccount = {
    id: 'account-1',
    userId: 'user-1',
    institutionId: 'inst-1',
    name: 'My Brokerage',
    typeId: 'type-1',
    description: null,
    metadata: {},
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockInstitution = {
    id: 'inst-1',
    name: 'Test Bank',
    typeId: 'inst-type-1',
    description: null,
    website: null,
    logoUrl: null,
    hasIntegration: false,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    // Reset all mocks
    for (const repo of [
      mockAccountRepository,
      mockInstitutionRepository,
      mockAccountTypeRepository,
      mockHoldingRepository,
      mockTokenRepository,
      mockGroupRepository,
      mockUserWalletService,
      mockPortfolioService,
    ]) {
      Object.values(repo).forEach((fn) => {
        if (typeof fn === 'function' && 'mockReset' in fn)
          (fn as ReturnType<typeof mock>).mockReset();
      });
    }

    // Set defaults
    mockAccountRepository.findById.mockImplementation(() => Promise.resolve(null));
    mockAccountRepository.findByUser.mockImplementation(() => Promise.resolve([]));
    mockAccountRepository.create.mockImplementation(() => Promise.resolve(null));
    mockAccountRepository.delete.mockImplementation(() => Promise.resolve(false));
    mockAccountRepository.updateAccount.mockImplementation(() => Promise.resolve(null));
    mockAccountRepository.findWalletAccounts.mockImplementation(() => Promise.resolve([]));
    mockAccountRepository.updateMetadata.mockImplementation(() => Promise.resolve());
    mockInstitutionRepository.findById.mockImplementation(() => Promise.resolve(null));
    mockAccountTypeRepository.findById.mockImplementation(() => Promise.resolve(null));
    mockHoldingRepository.findByUser.mockImplementation(() => Promise.resolve([]));
    mockTokenRepository.findByIds.mockImplementation(() => Promise.resolve([]));
    mockGroupRepository.findGroupsForAccounts.mockImplementation(() => Promise.resolve(new Map()));
    mockUserWalletService.removeInstitutionFromWallet.mockImplementation(() => Promise.resolve());
    mockPortfolioService.getUserPortfolioValue.mockImplementation(() =>
      Promise.resolve({ holdings: [], totalValue: '0' })
    );

    service = new AccountService();
  });

  describe('createAccount', () => {
    it('should create account successfully', async () => {
      mockInstitutionRepository.findById.mockImplementation(() => Promise.resolve(mockInstitution));
      mockAccountRepository.create.mockImplementation(() => Promise.resolve(mockAccount));

      const result = await service.createAccount(
        {
          name: 'My Brokerage',
          typeId: 'type-1',
          institutionId: 'inst-1',
        },
        'user-1'
      );

      expect(result.id).toBe('account-1');
      expect(result.name).toBe('My Brokerage');
      expect(mockAccountRepository.create).toHaveBeenCalled();
    });

    it('should reject when institution not found', async () => {
      await expect(
        service.createAccount(
          {
            name: 'My Account',
            typeId: 'type-1',
            institutionId: 'inst-nonexistent',
          },
          'user-1'
        )
      ).rejects.toThrow('not found');
    });

    it('should reject empty account name', async () => {
      mockInstitutionRepository.findById.mockImplementation(() => Promise.resolve(mockInstitution));

      await expect(
        service.createAccount(
          {
            name: '',
            typeId: 'type-1',
            institutionId: 'inst-1',
          },
          'user-1'
        )
      ).rejects.toThrow('cannot be empty');
    });

    it('should reject missing required fields', async () => {
      await expect(
        service.createAccount(
          {
            name: 'Account',
          } as any,
          'user-1'
        )
      ).rejects.toThrow('Missing required fields');
    });
  });

  describe('getAccountById', () => {
    it('should return account when found and owned by user', async () => {
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(mockAccount));

      const result = await service.getAccountById('user-1', 'account-1');

      expect(result.id).toBe('account-1');
    });

    it('should throw when account not found', async () => {
      await expect(service.getAccountById('user-1', 'nonexistent')).rejects.toThrow('not found');
    });

    it('should throw when account belongs to different user', async () => {
      mockAccountRepository.findById.mockImplementation(() =>
        Promise.resolve({ ...mockAccount, userId: 'user-other' })
      );

      await expect(service.getAccountById('user-1', 'account-1')).rejects.toThrow('Access denied');
    });
  });

  describe('getAccountsByUserId', () => {
    it('should return user accounts', async () => {
      mockAccountRepository.findByUser.mockImplementation(() => Promise.resolve([mockAccount]));

      const result = await service.getAccountsByUserId('user-1');

      expect(result).toHaveLength(1);
      expect(result[0]!.id).toBe('account-1');
    });

    it('should return empty array for user with no accounts', async () => {
      const result = await service.getAccountsByUserId('user-1');
      expect(result).toHaveLength(0);
    });
  });

  describe('deleteAccount', () => {
    it('should delete account successfully', async () => {
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(mockAccount));
      mockAccountRepository.delete.mockImplementation(() => Promise.resolve(true));

      const result = await service.deleteAccount('account-1', 'user-1');

      expect(result).toBe(true);
      expect(mockAccountRepository.delete).toHaveBeenCalledWith('account-1');
    });

    it('should throw when account not found', async () => {
      await expect(service.deleteAccount('nonexistent', 'user-1')).rejects.toThrow('not found');
    });

    it('should remove institution from wallet for migrated wallet accounts', async () => {
      const walletAccount = {
        ...mockAccount,
        metadata: { userWalletId: 'wallet-1', migrated: true },
      };
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(walletAccount));
      mockAccountRepository.delete.mockImplementation(() => Promise.resolve(true));

      await service.deleteAccount('account-1', 'user-1');

      expect(mockUserWalletService.removeInstitutionFromWallet).toHaveBeenCalledWith(
        'wallet-1',
        'inst-1'
      );
    });

    it('should still delete account if wallet service fails', async () => {
      const walletAccount = {
        ...mockAccount,
        metadata: { userWalletId: 'wallet-1', migrated: true },
      };
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(walletAccount));
      mockUserWalletService.removeInstitutionFromWallet.mockImplementation(() =>
        Promise.reject(new Error('wallet error'))
      );
      mockAccountRepository.delete.mockImplementation(() => Promise.resolve(true));

      const result = await service.deleteAccount('account-1', 'user-1');

      // Account should still be deleted even if wallet update fails
      expect(result).toBe(true);
    });
  });

  describe('updateAccount', () => {
    it('should update account name', async () => {
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(mockAccount));
      const updatedAccount = { ...mockAccount, name: 'New Name' };
      mockAccountRepository.updateAccount.mockImplementation(() => Promise.resolve(updatedAccount));

      const result = await service.updateAccount('account-1', { name: 'New Name' }, 'user-1');

      expect(result.name).toBe('New Name');
    });

    it('should throw when account not found', async () => {
      await expect(
        service.updateAccount('nonexistent', { name: 'New Name' }, 'user-1')
      ).rejects.toThrow('not found');
    });

    it('should throw when account belongs to different user', async () => {
      mockAccountRepository.findById.mockImplementation(() =>
        Promise.resolve({ ...mockAccount, userId: 'user-other' })
      );

      await expect(
        service.updateAccount('account-1', { name: 'New Name' }, 'user-1')
      ).rejects.toThrow('Access denied');
    });

    it('should prevent changing institution for synced accounts', async () => {
      const syncedAccount = {
        ...mockAccount,
        metadata: { walletAddress: '0xabc' },
      };
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(syncedAccount));

      await expect(
        service.updateAccount('account-1', { institutionId: 'inst-2' }, 'user-1')
      ).rejects.toThrow('Cannot change institution');
    });

    it('should prevent changing type for synced accounts', async () => {
      const syncedAccount = {
        ...mockAccount,
        metadata: { walletAddress: '0xabc' },
      };
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(syncedAccount));

      await expect(
        service.updateAccount('account-1', { typeId: 'type-2' }, 'user-1')
      ).rejects.toThrow('Cannot change account type');
    });

    it('should validate new institution exists when updating institutionId', async () => {
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(mockAccount));

      await expect(
        service.updateAccount('account-1', { institutionId: 'inst-nonexistent' }, 'user-1')
      ).rejects.toThrow('not found');
    });

    it('should validate new account type exists when updating typeId', async () => {
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(mockAccount));

      await expect(
        service.updateAccount('account-1', { typeId: 'type-nonexistent' }, 'user-1')
      ).rejects.toThrow('not found');
    });
  });

  describe('findWalletAccounts', () => {
    it('should delegate to repository', async () => {
      mockAccountRepository.findWalletAccounts.mockImplementation(() =>
        Promise.resolve([mockAccount])
      );

      const result = await service.findWalletAccounts();

      expect(result).toHaveLength(1);
    });
  });

  describe('updateAccountMetadata', () => {
    it('should delegate to repository', async () => {
      await service.updateAccountMetadata('account-1', { key: 'value' });

      expect(mockAccountRepository.updateMetadata).toHaveBeenCalledWith(
        'account-1',
        { key: 'value' },
        undefined
      );
    });
  });

  describe('getAccountsByUserIdWithSummary', () => {
    it('should return empty array for user with no accounts', async () => {
      const result = await service.getAccountsByUserIdWithSummary('user-1');
      expect(result).toHaveLength(0);
    });

    it('should return accounts with summary data', async () => {
      mockAccountRepository.findByUser.mockImplementation(() => Promise.resolve([mockAccount]));
      mockHoldingRepository.findByUser.mockImplementation(() =>
        Promise.resolve([
          {
            id: 'h-1',
            accountId: 'account-1',
            tokenId: 'token-1',
            balance: '10',
            isActive: true,
            userId: 'user-1',
            source: 'manual',
            isHidden: false,
            lastUpdated: new Date(),
            createdAt: new Date(),
          },
        ])
      );
      mockTokenRepository.findByIds.mockImplementation(() =>
        Promise.resolve([
          {
            id: 'token-1',
            symbol: 'BTC',
            name: 'Bitcoin',
            typeId: 'type-1',
            decimals: 8,
            iconUrl: null,
            providerMetadata: '{}',
            isScamProbability: 0,
            isActive: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        ])
      );
      mockPortfolioService.getUserPortfolioValue.mockImplementation(() =>
        Promise.resolve({
          holdings: [{ tokenSymbol: 'BTC', balance: '10', value: '500000' }],
          totalValue: '500000',
        })
      );
      mockGroupRepository.findGroupsForAccounts.mockImplementation(() =>
        Promise.resolve(new Map())
      );

      const result = await service.getAccountsByUserIdWithSummary('user-1');

      expect(result).toHaveLength(1);
      expect(result[0]!.summary.holdingsCount).toBe(1);
      expect(result[0]!.summary.totalValue).not.toBe('0');
    });
  });
});
