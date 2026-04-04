import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Mock database connection (BaseService imports getDb)
// Note: DATABASE_URL must be set before bun loads modules - use test-preload.ts
mock.module('../database/connection', () => ({
  db: {},
  getDb: () => ({}),
}));

// Mock typedi Container.get before importing the service
const mockCredentialsRepo = {
  findByUser: mock(() => Promise.resolve([])),
  findByUserAndInstitution: mock(() => Promise.resolve(null)),
  findByInstitution: mock(() => Promise.resolve([])),
  findByType: mock(() => Promise.resolve([])),
  create: mock(() => Promise.resolve(null)),
  update: mock(() => Promise.resolve(null)),
  updateLastUsed: mock(() => Promise.resolve()),
};

// Mock Container.get to return our mock repos
mock.module('typedi', () => ({
  Container: {
    get: mock(() => mockCredentialsRepo),
  },
  Service: () => (target: unknown) => target,
}));

// Mock the encryption module
const mockEncrypt = mock((_data: Record<string, unknown>) => ({
  encrypted: true,
  data: 'encrypted-data-base64',
}));

const mockDecrypt = mock((_data: Record<string, unknown>) => ({
  apiKey: 'decrypted-key',
  secret: 'decrypted-secret',
}));

mock.module('../utils/encryption', () => ({
  encryptCredentials: mockEncrypt,
  decryptCredentials: mockDecrypt,
  hasEncryptionKey: () => true,
}));

// Mock logger
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

// Import after mocking
import { IntegrationCredentialsService } from './IntegrationCredentialsService';

describe('IntegrationCredentialsService', () => {
  let service: IntegrationCredentialsService;

  const mockCredential = {
    id: 'cred-1',
    userId: 'user-1',
    institutionId: 'inst-1',
    encryptedCredentials: { encrypted: true, data: 'encrypted-data-base64' },
    credentialsType: 'oauth',
    isActive: true,
    lastUsedAt: new Date('2026-01-01'),
    expiresAt: null as Date | null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };

  beforeEach(() => {
    // Reset all mocks
    mockCredentialsRepo.findByUser.mockReset();
    mockCredentialsRepo.findByUserAndInstitution.mockReset();
    mockCredentialsRepo.findByInstitution.mockReset();
    mockCredentialsRepo.findByType.mockReset();
    mockCredentialsRepo.create.mockReset();
    mockCredentialsRepo.update.mockReset();
    mockCredentialsRepo.updateLastUsed.mockReset();
    mockEncrypt.mockReset();
    mockDecrypt.mockReset();

    // Set default implementations
    mockCredentialsRepo.findByUser.mockImplementation(() => Promise.resolve([]));
    mockCredentialsRepo.findByUserAndInstitution.mockImplementation(() => Promise.resolve(null));
    mockCredentialsRepo.findByInstitution.mockImplementation(() => Promise.resolve([]));
    mockCredentialsRepo.findByType.mockImplementation(() => Promise.resolve([]));
    mockCredentialsRepo.create.mockImplementation(() => Promise.resolve(null));
    mockCredentialsRepo.update.mockImplementation(() => Promise.resolve(null));
    mockCredentialsRepo.updateLastUsed.mockImplementation(() => Promise.resolve());
    mockEncrypt.mockImplementation(() => ({
      encrypted: true,
      data: 'encrypted-data-base64',
    }));
    mockDecrypt.mockImplementation(() => ({
      apiKey: 'decrypted-key',
      secret: 'decrypted-secret',
    }));

    service = new IntegrationCredentialsService();
  });

  describe('getUserCredentials', () => {
    it('should return credentials for user', async () => {
      mockCredentialsRepo.findByUser.mockImplementation(() => Promise.resolve([mockCredential]));

      const result = await service.getUserCredentials('user-1');

      expect(result).toHaveLength(1);
      expect(result[0]!.userId).toBe('user-1');
      expect(mockCredentialsRepo.findByUser).toHaveBeenCalledWith('user-1');
    });

    it('should return empty array when no credentials', async () => {
      const result = await service.getUserCredentials('user-1');

      expect(result).toHaveLength(0);
    });
  });

  describe('getCredentials', () => {
    it('should return credentials for user and institution', async () => {
      mockCredentialsRepo.findByUserAndInstitution.mockImplementation(() =>
        Promise.resolve(mockCredential)
      );

      const result = await service.getCredentials('user-1', 'inst-1');

      expect(result).not.toBeNull();
      expect(result!.institutionId).toBe('inst-1');
      expect(mockCredentialsRepo.findByUserAndInstitution).toHaveBeenCalledWith('user-1', 'inst-1');
    });

    it('should return null when no credentials found', async () => {
      const result = await service.getCredentials('user-1', 'inst-nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('getDecryptedCredentials', () => {
    it('should decrypt and return credentials', async () => {
      mockCredentialsRepo.findByUserAndInstitution.mockImplementation(() =>
        Promise.resolve(mockCredential)
      );

      const result = await service.getDecryptedCredentials('user-1', 'inst-1');

      expect(result).not.toBeNull();
      expect(result).toEqual({ apiKey: 'decrypted-key', secret: 'decrypted-secret' });
      expect(mockDecrypt).toHaveBeenCalledWith(mockCredential.encryptedCredentials);
    });

    it('should update lastUsed timestamp after decryption', async () => {
      mockCredentialsRepo.findByUserAndInstitution.mockImplementation(() =>
        Promise.resolve(mockCredential)
      );

      await service.getDecryptedCredentials('user-1', 'inst-1');

      expect(mockCredentialsRepo.updateLastUsed).toHaveBeenCalledWith('cred-1');
    });

    it('should return null when no credentials exist', async () => {
      const result = await service.getDecryptedCredentials('user-1', 'inst-nonexistent');

      expect(result).toBeNull();
      expect(mockDecrypt).not.toHaveBeenCalled();
    });
  });

  describe('storeCredentials', () => {
    it('should encrypt and create new credentials', async () => {
      const newCred = { ...mockCredential, id: 'cred-new' };
      mockCredentialsRepo.create.mockImplementation(() => Promise.resolve(newCred));

      const credentials = { apiKey: 'my-key', secret: 'my-secret' };
      const result = await service.storeCredentials('user-1', 'inst-1', credentials, 'api_key');

      expect(result.id).toBe('cred-new');
      expect(mockEncrypt).toHaveBeenCalledWith(credentials);
      expect(mockCredentialsRepo.create).toHaveBeenCalled();
    });

    it('should update existing credentials instead of creating duplicate', async () => {
      mockCredentialsRepo.findByUserAndInstitution.mockImplementation(() =>
        Promise.resolve(mockCredential)
      );

      const updatedCred = { ...mockCredential, credentialsType: 'api_key' };
      mockCredentialsRepo.update.mockImplementation(() => Promise.resolve(updatedCred));

      const credentials = { apiKey: 'new-key' };
      const result = await service.storeCredentials('user-1', 'inst-1', credentials, 'api_key');

      expect(result.id).toBe('cred-1');
      expect(mockCredentialsRepo.update).toHaveBeenCalledWith(
        'cred-1',
        expect.objectContaining({
          credentialsType: 'api_key',
          isActive: true,
        })
      );
      // Should not call create
      expect(mockCredentialsRepo.create).not.toHaveBeenCalled();
    });

    it('should pass expiresAt when provided', async () => {
      const newCred = { ...mockCredential, id: 'cred-new' };
      mockCredentialsRepo.create.mockImplementation(() => Promise.resolve(newCred));

      const expiresAt = new Date('2027-01-01');
      await service.storeCredentials('user-1', 'inst-1', { token: 'abc' }, 'oauth', expiresAt);

      expect(mockCredentialsRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          expiresAt,
          credentialsType: 'oauth',
        })
      );
    });
  });

  describe('updateCredentials', () => {
    it('should encrypt and update existing credentials', async () => {
      mockCredentialsRepo.findByUserAndInstitution.mockImplementation(() =>
        Promise.resolve(mockCredential)
      );
      const updatedCred = { ...mockCredential };
      mockCredentialsRepo.update.mockImplementation(() => Promise.resolve(updatedCred));

      const newCreds = { apiKey: 'updated-key' };
      const result = await service.updateCredentials('user-1', 'inst-1', newCreds);

      expect(result.id).toBe('cred-1');
      expect(mockEncrypt).toHaveBeenCalledWith(newCreds);
      expect(mockCredentialsRepo.update).toHaveBeenCalledWith(
        'cred-1',
        expect.objectContaining({
          encryptedCredentials: { encrypted: true, data: 'encrypted-data-base64' },
        })
      );
    });

    it('should throw when credentials not found', async () => {
      await expect(
        service.updateCredentials('user-1', 'inst-nonexistent', { key: 'val' })
      ).rejects.toThrow('Credentials not found');
    });
  });

  describe('deleteCredentials', () => {
    it('should soft-delete by setting isActive to false', async () => {
      mockCredentialsRepo.findByUserAndInstitution.mockImplementation(() =>
        Promise.resolve(mockCredential)
      );
      mockCredentialsRepo.update.mockImplementation(() =>
        Promise.resolve({ ...mockCredential, isActive: false })
      );

      await service.deleteCredentials('user-1', 'inst-1');

      expect(mockCredentialsRepo.update).toHaveBeenCalledWith('cred-1', { isActive: false });
    });

    it('should throw when credentials not found', async () => {
      await expect(service.deleteCredentials('user-1', 'inst-nonexistent')).rejects.toThrow(
        'Credentials not found'
      );
    });
  });

  describe('areCredentialsExpired', () => {
    it('should return false when no credentials exist', async () => {
      const result = await service.areCredentialsExpired('user-1', 'inst-1');
      expect(result).toBe(false);
    });

    it('should return false when expiresAt is null', async () => {
      mockCredentialsRepo.findByUserAndInstitution.mockImplementation(() =>
        Promise.resolve({ ...mockCredential, expiresAt: null })
      );

      const result = await service.areCredentialsExpired('user-1', 'inst-1');
      expect(result).toBe(false);
    });

    it('should return true when credentials are expired', async () => {
      mockCredentialsRepo.findByUserAndInstitution.mockImplementation(() =>
        Promise.resolve({
          ...mockCredential,
          expiresAt: new Date('2020-01-01'), // Past date
        })
      );

      const result = await service.areCredentialsExpired('user-1', 'inst-1');
      expect(result).toBe(true);
    });

    it('should return false when credentials are not yet expired', async () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      mockCredentialsRepo.findByUserAndInstitution.mockImplementation(() =>
        Promise.resolve({
          ...mockCredential,
          expiresAt: futureDate,
        })
      );

      const result = await service.areCredentialsExpired('user-1', 'inst-1');
      expect(result).toBe(false);
    });
  });

  describe('getInstitutionCredentials', () => {
    it('should return all credentials for an institution', async () => {
      mockCredentialsRepo.findByInstitution.mockImplementation(() =>
        Promise.resolve([mockCredential, { ...mockCredential, id: 'cred-2', userId: 'user-2' }])
      );

      const result = await service.getInstitutionCredentials('inst-1');

      expect(result).toHaveLength(2);
      expect(mockCredentialsRepo.findByInstitution).toHaveBeenCalledWith('inst-1');
    });
  });

  describe('getCredentialsByType', () => {
    it('should return credentials filtered by type', async () => {
      mockCredentialsRepo.findByType.mockImplementation(() => Promise.resolve([mockCredential]));

      const result = await service.getCredentialsByType('user-1', 'oauth');

      expect(result).toHaveLength(1);
      expect(mockCredentialsRepo.findByType).toHaveBeenCalledWith('user-1', 'oauth');
    });
  });
});
