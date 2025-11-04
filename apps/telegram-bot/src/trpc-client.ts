/**
 * tRPC Client for Telegram Bot
 *
 * This provides a simple interface to call backend tRPC procedures
 * with proper authentication context for Telegram users.
 */

export interface TRPCClientOptions {
  backendUrl: string;
  userId: string; // Scani user ID (mapped from Telegram)
}

export class TRPCClient {
  constructor(private options: TRPCClientOptions) {}

  /**
   * Generic method to call any tRPC procedure
   * In a real implementation, this would use the tRPC client
   * For now, we'll create a simplified version that interfaces with the backend
   */
  private async call(path: string, input?: any): Promise<any> {
    // This is a placeholder - in production, we'd use the actual tRPC client
    // or make HTTP calls to the tRPC endpoint with proper authentication
    throw new Error('TRPCClient not yet implemented - needs backend integration');
  }

  // Dashboard
  async getDashboardOverview() {
    return this.call('dashboard.getOverview');
  }

  // Accounts
  async listAccounts() {
    return this.call('accounts.getAll');
  }

  async getAccountDetails(accountId: string) {
    return this.call('accounts.getById', { id: accountId });
  }

  async deleteAccount(accountId: string) {
    return this.call('accounts.delete', { id: accountId });
  }

  // Holdings
  async listHoldings(accountId?: string) {
    if (accountId) {
      return this.call('accounts.getHoldings', { id: accountId });
    }
    return this.call('holdings.getWithDetails');
  }

  async updateHolding(holdingId: string, data: any) {
    return this.call('holdings.update', { id: holdingId, data });
  }

  async deleteHolding(holdingId: string) {
    return this.call('holdings.delete', { id: holdingId });
  }

  // Tokens
  async searchTokens(query: string, limit = 10) {
    // TODO: Implement token search in backend
    return this.call('tokens.search', { query, limit });
  }

  async getTokenPrice(symbol: string) {
    // TODO: Implement token price lookup
    return this.call('tokens.getPrice', { symbol });
  }

  // Institutions
  async listInstitutions(type?: string) {
    return this.call('institutions.getAll', type ? { type } : undefined);
  }

  // Batch operations
  async importHoldings(accountId: string, holdings: any[]) {
    return this.call('batchOperations.createHoldingsWithDependencies', {
      accountId,
      holdings,
    });
  }

  // Types
  async listInstitutionTypes() {
    return this.call('institutionTypes.getAll');
  }

  async listAccountTypes() {
    return this.call('accountTypes.getAll');
  }
}
