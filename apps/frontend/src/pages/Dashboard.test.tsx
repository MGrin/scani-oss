import { describe, expect, it } from 'bun:test';
import { FinancialMath } from '@scani/shared';

// Test the FinancialMath integration in Dashboard calculations
describe('Dashboard Financial Calculations', () => {
  describe('Total Holdings Value Calculation', () => {
    it('should calculate total holdings value correctly', () => {
      const mockHoldings = [
        {
          id: '1',
          accountId: 'acc1',
          tokenId: 'usd',
          balance: 1000.5,
          lastUpdated: new Date(),
          createdAt: new Date(),
        },
        {
          id: '2',
          accountId: 'acc1',
          tokenId: 'eur',
          balance: 850.25,
          lastUpdated: new Date(),
          createdAt: new Date(),
        },
        {
          id: '3',
          accountId: 'acc2',
          tokenId: 'btc',
          balance: 0.5,
          lastUpdated: new Date(),
          createdAt: new Date(),
        },
      ];

      // Simulate the Dashboard calculation
      const totalHoldingsValue = FinancialMath.toNumber(
        FinancialMath.sum(mockHoldings.map((holding) => FinancialMath.abs(holding.balance)))
      );

      expect(totalHoldingsValue).toBe(1851.25); // 1000.50 + 850.25 + 0.5
    });

    it('should handle negative balances (short positions) correctly', () => {
      const mockHoldings = [
        {
          id: '1',
          accountId: 'acc1',
          tokenId: 'usd',
          balance: 1000,
          lastUpdated: new Date(),
          createdAt: new Date(),
        },
        {
          id: '2',
          accountId: 'acc1',
          tokenId: 'stock',
          balance: -500,
          lastUpdated: new Date(),
          createdAt: new Date(),
        }, // short position
      ];

      const totalHoldingsValue = FinancialMath.toNumber(
        FinancialMath.sum(mockHoldings.map((holding) => FinancialMath.abs(holding.balance)))
      );

      expect(totalHoldingsValue).toBe(1500); // abs(1000) + abs(-500) = 1500
    });

    it('should handle empty holdings array', () => {
      const mockHoldings: {
        id: string;
        accountId: string;
        tokenId: string;
        balance: number;
        lastUpdated: Date;
        createdAt: Date;
      }[] = [];

      const totalHoldingsValue = FinancialMath.toNumber(
        FinancialMath.sum(mockHoldings.map((holding) => FinancialMath.abs(holding.balance)))
      );

      expect(totalHoldingsValue).toBe(0);
    });
  });

  describe('Holdings by Token Type Calculation', () => {
    it('should group holdings by token type correctly', () => {
      const mockHoldings = [
        {
          id: '1',
          accountId: 'acc1',
          tokenId: 'token1',
          balance: 1000,
          lastUpdated: new Date(),
          createdAt: new Date(),
        },
        {
          id: '2',
          accountId: 'acc1',
          tokenId: 'token2',
          balance: 500,
          lastUpdated: new Date(),
          createdAt: new Date(),
        },
        {
          id: '3',
          accountId: 'acc2',
          tokenId: 'token3',
          balance: 0.5,
          lastUpdated: new Date(),
          createdAt: new Date(),
        },
      ];

      const mockTokensMap = {
        token1: { type: 'fiat' },
        token2: { type: 'fiat' },
        token3: { type: 'crypto' },
      };

      // Simulate Dashboard grouping logic
      const holdingsByTokenType = mockHoldings.reduce(
        (
          acc: Record<string, { count: number; totalValue: number; holdings: typeof mockHoldings }>,
          holding
        ) => {
          const token = mockTokensMap[holding.tokenId as keyof typeof mockTokensMap];
          if (!token) return acc;

          const tokenType = token.type;
          if (!acc[tokenType]) {
            acc[tokenType] = {
              count: 0,
              totalValue: 0,
              holdings: [],
            };
          }

          acc[tokenType].count += 1;
          acc[tokenType].totalValue = FinancialMath.toNumber(
            FinancialMath.add(acc[tokenType].totalValue, FinancialMath.abs(holding.balance))
          );
          acc[tokenType].holdings.push(holding);

          return acc;
        },
        {}
      );

      expect(holdingsByTokenType).toEqual({
        fiat: {
          count: 2,
          totalValue: 1500, // 1000 + 500
          holdings: expect.arrayContaining([
            expect.objectContaining({ id: '1' }),
            expect.objectContaining({ id: '2' }),
          ]),
        },
        crypto: {
          count: 1,
          totalValue: 0.5,
          holdings: expect.arrayContaining([expect.objectContaining({ id: '3' })]),
        },
      });
    });
  });

  describe('Monthly Transaction Calculations', () => {
    it('should calculate monthly deposits correctly', () => {
      const mockTransactions = [
        {
          id: '1',
          type: 'deposit',
          amount: 500,
          timestamp: new Date('2023-06-15'), // current month
        },
        {
          id: '2',
          type: 'deposit',
          amount: 300,
          timestamp: new Date('2023-06-20'), // current month
        },
        {
          id: '3',
          type: 'deposit',
          amount: 200,
          timestamp: new Date('2023-05-15'), // previous month
        },
        {
          id: '4',
          type: 'withdrawal',
          amount: 100,
          timestamp: new Date('2023-06-25'), // should be ignored for deposits
        },
      ];

      const currentMonth = 5; // June (0-indexed)

      const monthlyDeposits = FinancialMath.toNumber(
        FinancialMath.sum(
          mockTransactions
            .filter(
              (t) => t.type === 'deposit' && new Date(t.timestamp).getMonth() === currentMonth
            )
            .map((t) => FinancialMath.abs(t.amount))
        )
      );

      expect(monthlyDeposits).toBe(800); // 500 + 300
    });

    it('should calculate net flow correctly', () => {
      const monthlyDeposits = 1000;
      const monthlyWithdrawals = 600;

      const netFlow = FinancialMath.formatCurrency(
        FinancialMath.subtract(monthlyDeposits, monthlyWithdrawals)
      );

      expect(netFlow).toBe('$400.00');
    });

    it('should handle negative net flow', () => {
      const monthlyDeposits = 400;
      const monthlyWithdrawals = 700;

      const netFlow = FinancialMath.formatCurrency(
        FinancialMath.subtract(monthlyDeposits, monthlyWithdrawals)
      );

      expect(netFlow).toBe('-$300.00');
    });
  });

  describe('Currency Formatting', () => {
    it('should format currency consistently', () => {
      expect(FinancialMath.formatCurrency(1234.56)).toBe('$1,234.56');
      expect(FinancialMath.formatCurrency(0)).toBe('$0.00');
      expect(FinancialMath.formatCurrency(-500.25)).toBe('-$500.25');
      expect(FinancialMath.formatCurrency(1000000.99)).toBe('$1,000,000.99');
    });

    it('should handle very small amounts', () => {
      expect(FinancialMath.formatCurrency(0.01)).toBe('$0.01');
      expect(FinancialMath.formatCurrency(0.001, { decimals: 3 })).toBe('$0.001');
    });

    it('should handle crypto precision', () => {
      // Bitcoin with 8 decimal places
      expect(FinancialMath.formatCurrency(0.12345678, { decimals: 8, style: 'decimal' })).toBe(
        '0.12345678'
      );

      // Ethereum with 18 decimal places (showing 6 for display)
      expect(FinancialMath.formatCurrency(1.123457, { decimals: 6, style: 'decimal' })).toBe(
        '1.123457'
      );
    });
  });

  describe('Percentage Calculations', () => {
    it('should calculate portfolio allocation percentages', () => {
      const totalPortfolioValue = 10000;
      const fiatValue = 6000;
      const cryptoValue = 3000;
      const stockValue = 1000;

      const fiatPercentage = FinancialMath.percentage(fiatValue, totalPortfolioValue);
      const cryptoPercentage = FinancialMath.percentage(cryptoValue, totalPortfolioValue);
      const stockPercentage = FinancialMath.percentage(stockValue, totalPortfolioValue);

      expect(FinancialMath.toNumber(fiatPercentage)).toBe(60);
      expect(FinancialMath.toNumber(cryptoPercentage)).toBe(30);
      expect(FinancialMath.toNumber(stockPercentage)).toBe(10);

      // Should sum to 100%
      const total = FinancialMath.toNumber(
        FinancialMath.sum([fiatPercentage, cryptoPercentage, stockPercentage])
      );
      expect(total).toBe(100);
    });

    it('should handle zero total value', () => {
      const percentage = FinancialMath.percentage(100, 0);
      expect(FinancialMath.toNumber(percentage)).toBe(0);
    });
  });

  describe('Top Holdings Sorting', () => {
    it('should sort holdings by value descending', () => {
      const mockHoldings = [
        { id: '1', balance: 1000, token: { symbol: 'USD' } },
        { id: '2', balance: 0.5, token: { symbol: 'BTC' } },
        { id: '3', balance: 2000, token: { symbol: 'EUR' } },
        { id: '4', balance: 500, token: { symbol: 'CHF' } },
      ];

      const topHoldings = mockHoldings
        .map((holding) => ({
          ...holding,
          value: FinancialMath.toNumber(FinancialMath.abs(holding.balance)),
        }))
        .sort((a, b) => b.value - a.value)
        .slice(0, 3); // top 3

      expect(topHoldings).toHaveLength(3);
      expect(topHoldings[0]?.id).toBe('3'); // EUR with 2000
      expect(topHoldings[1]?.id).toBe('1'); // USD with 1000
      expect(topHoldings[2]?.id).toBe('4'); // CHF with 500
    });

    it('should handle negative balances in sorting', () => {
      const mockHoldings = [
        { id: '1', balance: 1000, token: { symbol: 'USD' } },
        { id: '2', balance: -1500, token: { symbol: 'SHORT' } }, // short position
        { id: '3', balance: 500, token: { symbol: 'EUR' } },
      ];

      const topHoldings = mockHoldings
        .map((holding) => ({
          ...holding,
          value: FinancialMath.toNumber(FinancialMath.abs(holding.balance)),
        }))
        .sort((a, b) => b.value - a.value);

      expect(topHoldings[0]?.id).toBe('2'); // SHORT with abs(1500)
      expect(topHoldings[0]?.value).toBe(1500);
      expect(topHoldings[1]?.id).toBe('1'); // USD with 1000
      expect(topHoldings[2]?.id).toBe('3'); // EUR with 500
    });
  });
});
