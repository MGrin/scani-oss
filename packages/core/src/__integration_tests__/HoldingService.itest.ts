import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock database connection (BaseService imports getDb)
// Note: DATABASE_URL must be set before bun loads modules - use test-preload.ts
mock.module('../database/connection', () => ({
  db: {},
  getDb: () => ({}),
}));

// Mock repositories
const mockHoldingRepository = {
  findById: mock(() => Promise.resolve(null)),
  findByAccount: mock(() => Promise.resolve([])),
  findByAccountAndToken: mock(() => Promise.resolve(null)),
  findByUserWithFullDetails: mock(() => Promise.resolve([])),
  findByUser: mock(() => Promise.resolve([])),
  create: mock(() => Promise.resolve({ id: 'holding-1' })),
  createMany: mock(() => Promise.resolve([])),
  update: mock(() => Promise.resolve(null)),
  updateBalance: mock(() => Promise.resolve()),
  deleteById: mock(() => Promise.resolve()),
  markAsHidden: mock(() => Promise.resolve()),
  unhideHolding: mock(() => Promise.resolve()),
  getDistinctTokenIds: mock(() => Promise.resolve([])),
};

const mockAccountRepository = {
  findById: mock(() => Promise.resolve(null)),
};

const mockGroupRepository = {
  findGroupsForHoldings: mock(() => Promise.resolve(new Map())),
};

const mockTokenRepository = {
  findById: mock(() => Promise.resolve(null)),
};

const mockPortfolioValuationService = {
  getUserPortfolioValue: mock(() => Promise.resolve({ holdings: [], totalValue: '0' })),
};

const mockUserPortfolioEventService = {
  createHoldingCreateEvent: mock(() => Promise.resolve()),
  createHoldingUpdateEvent: mock(() => Promise.resolve()),
  createHoldingDeleteEvent: mock(() => Promise.resolve()),
};

// Keep a map to return the right mock based on class
const _mockMap = new Map<string, unknown>();

mock.module('typedi', () => ({
  Container: {
    get: (cls: { name?: string }) => {
      const name = cls?.name || '';
      if (name.includes('HoldingRepository')) return mockHoldingRepository;
      if (name.includes('AccountRepository')) return mockAccountRepository;
      if (name.includes('GroupRepository')) return mockGroupRepository;
      if (name.includes('TokenRepository')) return mockTokenRepository;
      if (name.includes('PortfolioValuationService')) return mockPortfolioValuationService;
      if (name.includes('UserPortfolioEventService')) return mockUserPortfolioEventService;
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

import { HoldingService } from './HoldingService';

describe('HoldingService', () => {
  let service: HoldingService;

  const mockAccount = {
    id: 'account-1',
    userId: 'user-1',
    institutionId: 'inst-1',
    name: 'My Account',
    typeId: 'type-1',
    description: null,
    metadata: {},
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockToken = {
    id: 'token-1',
    symbol: 'BTC',
    name: 'Bitcoin',
    typeId: 'type-crypto',
    decimals: 8,
    iconUrl: null,
    providerMetadata: '{}',
    isScamProbability: 0,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockHolding = {
    id: 'holding-1',
    userId: 'user-1',
    accountId: 'account-1',
    tokenId: 'token-1',
    balance: '1.5',
    source: 'manual',
    isHidden: false,
    isActive: true,
    lastUpdated: new Date(),
    createdAt: new Date(),
  };

  beforeEach(() => {
    // Reset all mocks
    Object.values(mockHoldingRepository).forEach((fn) => {
      if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
    });
    Object.values(mockAccountRepository).forEach((fn) => {
      if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
    });
    Object.values(mockTokenRepository).forEach((fn) => {
      if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
    });
    Object.values(mockUserPortfolioEventService).forEach((fn) => {
      if (typeof fn === 'function' && 'mockReset' in fn) fn.mockReset();
    });

    // Set defaults
    mockHoldingRepository.findById.mockImplementation(() => Promise.resolve(null));
    mockHoldingRepository.findByAccountAndToken.mockImplementation(() => Promise.resolve(null));
    mockHoldingRepository.create.mockImplementation((data: Record<string, unknown>) =>
      Promise.resolve({ ...mockHolding, ...data })
    );
    mockHoldingRepository.createMany.mockImplementation(() => Promise.resolve([]));
    mockHoldingRepository.update.mockImplementation(() => Promise.resolve(null));
    mockHoldingRepository.updateBalance.mockImplementation(() => Promise.resolve());
    mockHoldingRepository.deleteById.mockImplementation(() => Promise.resolve());
    mockHoldingRepository.markAsHidden.mockImplementation(() => Promise.resolve());
    mockHoldingRepository.unhideHolding.mockImplementation(() => Promise.resolve());
    mockHoldingRepository.getDistinctTokenIds.mockImplementation(() => Promise.resolve([]));
    mockAccountRepository.findById.mockImplementation(() => Promise.resolve(null));
    mockTokenRepository.findById.mockImplementation(() => Promise.resolve(null));
    mockUserPortfolioEventService.createHoldingCreateEvent.mockImplementation(() =>
      Promise.resolve()
    );
    mockUserPortfolioEventService.createHoldingUpdateEvent.mockImplementation(() =>
      Promise.resolve()
    );
    mockUserPortfolioEventService.createHoldingDeleteEvent.mockImplementation(() =>
      Promise.resolve()
    );

    service = new HoldingService();
  });

  describe('createHolding', () => {
    it('should create a holding successfully', async () => {
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(mockAccount));
      mockHoldingRepository.findByAccountAndToken.mockImplementation(() => Promise.resolve(null));
      mockHoldingRepository.create.mockImplementation(() => Promise.resolve(mockHolding));

      const result = await service.createHolding(
        { accountId: 'account-1', tokenId: 'token-1', balance: '1.5' },
        'user-1'
      );

      expect(result.id).toBe('holding-1');
      expect(result.balance).toBe('1.5');
      expect(mockHoldingRepository.create).toHaveBeenCalled();
    });

    it('should reject negative balance', async () => {
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(mockAccount));

      await expect(
        service.createHolding(
          { accountId: 'account-1', tokenId: 'token-1', balance: '-1' },
          'user-1'
        )
      ).rejects.toThrow('Balance cannot be negative');
    });

    it('should reject if account not found', async () => {
      await expect(
        service.createHolding(
          { accountId: 'account-nonexistent', tokenId: 'token-1', balance: '1.0' },
          'user-1'
        )
      ).rejects.toThrow('not found');
    });

    it('should reject if account belongs to different user', async () => {
      mockAccountRepository.findById.mockImplementation(() =>
        Promise.resolve({ ...mockAccount, userId: 'user-other' })
      );

      await expect(
        service.createHolding(
          { accountId: 'account-1', tokenId: 'token-1', balance: '1.0' },
          'user-1'
        )
      ).rejects.toThrow('Unauthorized');
    });

    it('should reject duplicate holding for same token in same account', async () => {
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(mockAccount));
      mockHoldingRepository.findByAccountAndToken.mockImplementation(() =>
        Promise.resolve(mockHolding)
      );

      await expect(
        service.createHolding(
          { accountId: 'account-1', tokenId: 'token-1', balance: '2.0' },
          'user-1'
        )
      ).rejects.toThrow('Holding already exists');
    });

    it('should accept zero balance', async () => {
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(mockAccount));
      mockHoldingRepository.create.mockImplementation(() =>
        Promise.resolve({ ...mockHolding, balance: '0' })
      );

      const result = await service.createHolding(
        { accountId: 'account-1', tokenId: 'token-1', balance: '0' },
        'user-1'
      );

      expect(result.balance).toBe('0');
    });
  });

  describe('createHoldingWithEvent', () => {
    it('should create holding and event when event context provided', async () => {
      mockHoldingRepository.create.mockImplementation(() => Promise.resolve(mockHolding));
      mockTokenRepository.findById.mockImplementation(() => Promise.resolve(mockToken));
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(mockAccount));

      const result = await service.createHoldingWithEvent({
        accountId: 'account-1',
        tokenId: 'token-1',
        balance: '1.5',
        userId: 'user-1',
        eventContext: {
          baseCurrencyId: 'currency-usd',
          price: '50000',
        },
      });

      expect(result.id).toBe('holding-1');
      expect(mockUserPortfolioEventService.createHoldingCreateEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          holdingId: 'holding-1',
          tokenSymbol: 'BTC',
          balance: '1.5',
          price: '50000',
        }),
        undefined
      );
    });

    it('should create holding without event when no event context', async () => {
      mockHoldingRepository.create.mockImplementation(() => Promise.resolve(mockHolding));

      const result = await service.createHoldingWithEvent({
        accountId: 'account-1',
        tokenId: 'token-1',
        balance: '1.5',
        userId: 'user-1',
      });

      expect(result.id).toBe('holding-1');
      expect(mockUserPortfolioEventService.createHoldingCreateEvent).not.toHaveBeenCalled();
    });

    it('should use "0" as default price when not provided in event context', async () => {
      mockHoldingRepository.create.mockImplementation(() => Promise.resolve(mockHolding));
      mockTokenRepository.findById.mockImplementation(() => Promise.resolve(mockToken));
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(mockAccount));

      await service.createHoldingWithEvent({
        accountId: 'account-1',
        tokenId: 'token-1',
        balance: '1.5',
        userId: 'user-1',
        eventContext: {
          baseCurrencyId: 'currency-usd',
        },
      });

      expect(mockUserPortfolioEventService.createHoldingCreateEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          price: '0',
        }),
        undefined
      );
    });

    it('should default source to "manual"', async () => {
      mockHoldingRepository.create.mockImplementation((data: Record<string, unknown>) =>
        Promise.resolve({ ...mockHolding, ...data })
      );

      await service.createHoldingWithEvent({
        accountId: 'account-1',
        tokenId: 'token-1',
        balance: '1.0',
        userId: 'user-1',
      });

      expect(mockHoldingRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'manual',
        }),
        undefined
      );
    });
  });

  describe('updateHoldingBalanceWithEvent', () => {
    it('should update balance and create event', async () => {
      mockHoldingRepository.findById.mockImplementation(() => Promise.resolve(mockHolding));
      mockTokenRepository.findById.mockImplementation(() => Promise.resolve(mockToken));
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(mockAccount));

      await service.updateHoldingBalanceWithEvent({
        holdingId: 'holding-1',
        balance: '2.5',
        eventContext: {
          userId: 'user-1',
          baseCurrencyId: 'currency-usd',
          price: '60000',
        },
      });

      expect(mockHoldingRepository.updateBalance).toHaveBeenCalledWith(
        'holding-1',
        '2.5',
        undefined
      );
      expect(mockUserPortfolioEventService.createHoldingUpdateEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          holdingId: 'holding-1',
          balance: '2.5',
          price: '60000',
        }),
        undefined
      );
    });

    it('should throw when holding not found', async () => {
      await expect(
        service.updateHoldingBalanceWithEvent({
          holdingId: 'nonexistent',
          balance: '1.0',
        })
      ).rejects.toThrow('Holding not found');
    });

    it('should update balance without event when no context', async () => {
      mockHoldingRepository.findById.mockImplementation(() => Promise.resolve(mockHolding));

      await service.updateHoldingBalanceWithEvent({
        holdingId: 'holding-1',
        balance: '3.0',
      });

      expect(mockHoldingRepository.updateBalance).toHaveBeenCalledWith(
        'holding-1',
        '3.0',
        undefined
      );
      expect(mockUserPortfolioEventService.createHoldingUpdateEvent).not.toHaveBeenCalled();
    });
  });

  describe('deleteHoldingWithEvent', () => {
    it('should delete holding and create event', async () => {
      mockHoldingRepository.findById.mockImplementation(() => Promise.resolve(mockHolding));
      mockTokenRepository.findById.mockImplementation(() => Promise.resolve(mockToken));
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(mockAccount));

      await service.deleteHoldingWithEvent('holding-1', {
        userId: 'user-1',
        baseCurrencyId: 'currency-usd',
        price: '50000',
      });

      expect(mockHoldingRepository.deleteById).toHaveBeenCalledWith('holding-1', undefined);
      expect(mockUserPortfolioEventService.createHoldingDeleteEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          holdingId: 'holding-1',
          tokenSymbol: 'BTC',
        }),
        undefined
      );
    });

    it('should throw when holding not found for deletion', async () => {
      await expect(
        service.deleteHoldingWithEvent('nonexistent', {
          userId: 'user-1',
          baseCurrencyId: 'currency-usd',
        })
      ).rejects.toThrow('Holding not found');
    });
  });

  describe('hideHoldingWithEvent', () => {
    it('should hide holding and create delete event', async () => {
      mockHoldingRepository.findById.mockImplementation(() => Promise.resolve(mockHolding));
      mockTokenRepository.findById.mockImplementation(() => Promise.resolve(mockToken));
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(mockAccount));

      await service.hideHoldingWithEvent('holding-1', {
        userId: 'user-1',
        baseCurrencyId: 'currency-usd',
      });

      expect(mockHoldingRepository.markAsHidden).toHaveBeenCalledWith('holding-1', undefined);
      // Hiding is treated as deletion for portfolio history
      expect(mockUserPortfolioEventService.createHoldingDeleteEvent).toHaveBeenCalled();
    });
  });

  describe('unhideHoldingWithEvent', () => {
    it('should unhide holding and create create event', async () => {
      mockHoldingRepository.findById.mockImplementation(() => Promise.resolve(mockHolding));
      mockHoldingRepository.unhideHolding.mockImplementation(() => Promise.resolve());
      // After unhide, findById is called again to return the updated holding
      // First call (with includeHidden=true) returns the hidden holding
      // Second call (with includeHidden=false) returns the unhidden holding
      let _callCount = 0;
      mockHoldingRepository.findById.mockImplementation(() => {
        _callCount++;
        return Promise.resolve(mockHolding);
      });
      mockTokenRepository.findById.mockImplementation(() => Promise.resolve(mockToken));
      mockAccountRepository.findById.mockImplementation(() => Promise.resolve(mockAccount));

      const _result = await service.unhideHoldingWithEvent('holding-1', {
        userId: 'user-1',
        baseCurrencyId: 'currency-usd',
      });

      expect(mockHoldingRepository.unhideHolding).toHaveBeenCalledWith('holding-1', undefined);
      // Unhiding is treated as creation for portfolio history
      expect(mockUserPortfolioEventService.createHoldingCreateEvent).toHaveBeenCalled();
    });
  });

  describe('findByAccount', () => {
    it('should delegate to repository', async () => {
      mockHoldingRepository.findByAccount.mockImplementation(() => Promise.resolve([mockHolding]));

      const result = await service.findByAccount('account-1');

      expect(result).toHaveLength(1);
      expect(mockHoldingRepository.findByAccount).toHaveBeenCalledWith(
        'account-1',
        undefined,
        false,
        false
      );
    });

    it('should pass includeHidden flag', async () => {
      mockHoldingRepository.findByAccount.mockImplementation(() => Promise.resolve([]));

      await service.findByAccount('account-1', undefined, true);

      expect(mockHoldingRepository.findByAccount).toHaveBeenCalledWith(
        'account-1',
        undefined,
        true,
        false
      );
    });
  });

  describe('findById', () => {
    it('should return holding when found', async () => {
      mockHoldingRepository.findById.mockImplementation(() => Promise.resolve(mockHolding));

      const result = await service.findById('holding-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('holding-1');
    });

    it('should return null when not found', async () => {
      const result = await service.findById('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('getDistinctTokenIds', () => {
    it('should delegate to repository', async () => {
      mockHoldingRepository.getDistinctTokenIds.mockImplementation(() =>
        Promise.resolve(['token-1', 'token-2'])
      );

      const result = await service.getDistinctTokenIds();

      expect(result).toEqual(['token-1', 'token-2']);
    });
  });
});
