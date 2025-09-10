import { describe, expect, it } from 'bun:test';
import { Decimal } from 'decimal.js';
import { FinancialMath } from './financial';

describe('FinancialMath', () => {
  describe('add', () => {
    it('should add two positive numbers', () => {
      const result = FinancialMath.add(1.1, 2.2);
      expect(result.toString()).toBe('3.3');
    });

    it('should add number and string', () => {
      const result = FinancialMath.add(1.5, '2.5');
      expect(result.toString()).toBe('4');
    });

    it('should add Decimal objects', () => {
      const result = FinancialMath.add(new Decimal('1.111'), new Decimal('2.222'));
      expect(result.toString()).toBe('3.333');
    });

    it('should handle negative numbers', () => {
      const result = FinancialMath.add(-5.5, 3.3);
      expect(result.toString()).toBe('-2.2');
    });
  });

  describe('subtract', () => {
    it('should subtract two numbers', () => {
      const result = FinancialMath.subtract(5.5, 2.2);
      expect(result.toString()).toBe('3.3');
    });

    it('should handle negative results', () => {
      const result = FinancialMath.subtract(2.2, 5.5);
      expect(result.toString()).toBe('-3.3');
    });
  });

  describe('multiply', () => {
    it('should multiply two numbers', () => {
      const result = FinancialMath.multiply(2.5, 4);
      expect(result.toString()).toBe('10');
    });

    it('should handle decimal multiplication precisely', () => {
      const result = FinancialMath.multiply(0.1, 0.2);
      expect(result.toString()).toBe('0.02');
    });
  });

  describe('divide', () => {
    it('should divide two numbers', () => {
      const result = FinancialMath.divide(10, 4);
      expect(result.toString()).toBe('2.5');
    });

    it('should handle division by decimal', () => {
      const result = FinancialMath.divide(1, 3);
      // Should maintain precision
      expect(result.toFixed(10)).toBe('0.3333333333');
    });

    it('should handle division by zero returning Infinity', () => {
      const result = FinancialMath.divide(10, 0);
      expect(result.toString()).toBe('Infinity');
    });
  });

  describe('abs', () => {
    it('should return absolute value of positive number', () => {
      const result = FinancialMath.abs(5.5);
      expect(result.toString()).toBe('5.5');
    });

    it('should return absolute value of negative number', () => {
      const result = FinancialMath.abs(-5.5);
      expect(result.toString()).toBe('5.5');
    });

    it('should return zero for zero', () => {
      const result = FinancialMath.abs(0);
      expect(result.toString()).toBe('0');
    });
  });

  describe('compare', () => {
    it('should return -1 when a < b', () => {
      const result = FinancialMath.compare(1, 2);
      expect(result).toBe(-1);
    });

    it('should return 0 when a = b', () => {
      const result = FinancialMath.compare(2, 2);
      expect(result).toBe(0);
    });

    it('should return 1 when a > b', () => {
      const result = FinancialMath.compare(3, 2);
      expect(result).toBe(1);
    });
  });

  describe('equals', () => {
    it('should return true for equal values', () => {
      expect(FinancialMath.equals(1.1, 1.1)).toBe(true);
    });

    it('should return false for different values', () => {
      expect(FinancialMath.equals(1.1, 1.2)).toBe(false);
    });

    it('should handle string comparison', () => {
      expect(FinancialMath.equals('1.1', 1.1)).toBe(true);
    });
  });

  describe('greaterThan', () => {
    it('should return true when a > b', () => {
      expect(FinancialMath.greaterThan(2, 1)).toBe(true);
    });

    it('should return false when a <= b', () => {
      expect(FinancialMath.greaterThan(1, 1)).toBe(false);
      expect(FinancialMath.greaterThan(1, 2)).toBe(false);
    });
  });

  describe('lessThan', () => {
    it('should return true when a < b', () => {
      expect(FinancialMath.lessThan(1, 2)).toBe(true);
    });

    it('should return false when a >= b', () => {
      expect(FinancialMath.lessThan(2, 2)).toBe(false);
      expect(FinancialMath.lessThan(2, 1)).toBe(false);
    });
  });

  describe('formatCurrency', () => {
    it('should format currency with default settings', () => {
      const result = FinancialMath.formatCurrency(1234.56);
      expect(result).toBe('$1,234.56');
    });

    it('should format currency with custom decimals', () => {
      const result = FinancialMath.formatCurrency(1234.567, { decimals: 3 });
      expect(result).toBe('$1,234.567');
    });

    it('should format currency with custom symbol', () => {
      const result = FinancialMath.formatCurrency(1234.56, { currency: 'EUR' });
      expect(result).toBe('€1,234.56');
    });

    it('should format large numbers with thousands separator', () => {
      const result = FinancialMath.formatCurrency(1234567.89);
      expect(result).toBe('$1,234,567.89');
    });

    it('should handle zero', () => {
      const result = FinancialMath.formatCurrency(0);
      expect(result).toBe('$0.00');
    });

    it('should handle negative numbers', () => {
      const result = FinancialMath.formatCurrency(-1234.56);
      expect(result).toBe('-$1,234.56');
    });
  });

  describe('round', () => {
    it('should round to default 2 decimals', () => {
      const result = FinancialMath.round(1.2345);
      expect(result.toString()).toBe('1.23');
    });

    it('should round to custom decimals', () => {
      const result = FinancialMath.round(1.2345, 3);
      expect(result.toString()).toBe('1.235');
    });

    it('should handle rounding up', () => {
      const result = FinancialMath.round(1.236, 2);
      expect(result.toString()).toBe('1.24');
    });
  });

  describe('toNumber', () => {
    it('should convert Decimal to number', () => {
      const decimal = new Decimal('123.456');
      const result = FinancialMath.toNumber(decimal);
      expect(result).toBe(123.456);
      expect(typeof result).toBe('number');
    });
  });

  describe('sum', () => {
    it('should sum an array of numbers', () => {
      const result = FinancialMath.sum([1, 2, 3, 4]);
      expect(result.toString()).toBe('10');
    });

    it('should sum mixed types', () => {
      const result = FinancialMath.sum([1, '2', new Decimal('3')]);
      expect(result.toString()).toBe('6');
    });

    it('should handle empty array', () => {
      const result = FinancialMath.sum([]);
      expect(result.toString()).toBe('0');
    });

    it('should handle decimal precision', () => {
      const result = FinancialMath.sum([0.1, 0.2, 0.3]);
      expect(result.toString()).toBe('0.6');
    });
  });

  describe('percentage', () => {
    it('should calculate percentage', () => {
      const result = FinancialMath.percentage(25, 100);
      expect(result.toString()).toBe('25');
    });

    it('should handle zero total', () => {
      const result = FinancialMath.percentage(25, 0);
      expect(result.toString()).toBe('0');
    });

    it('should calculate percentage with decimals', () => {
      const result = FinancialMath.percentage(33.33, 100);
      expect(result.toString()).toBe('33.33');
    });
  });

  describe('percentageChange', () => {
    it('should calculate positive percentage change', () => {
      const result = FinancialMath.percentageChange(100, 120);
      expect(result.toString()).toBe('20');
    });

    it('should calculate negative percentage change', () => {
      const result = FinancialMath.percentageChange(100, 80);
      expect(result.toString()).toBe('-20');
    });

    it('should handle zero old value', () => {
      const result = FinancialMath.percentageChange(0, 100);
      expect(result.toString()).toBe('0');
    });
  });

  describe('compoundInterest', () => {
    it('should calculate compound interest', () => {
      // $1000 at 5% annually for 2 years
      const result = FinancialMath.compoundInterest(1000, 5, 2, 1);
      expect(result.toFixed(2)).toBe('1102.50');
    });

    it('should calculate with monthly compounding', () => {
      // $1000 at 5% annually for 1 year, compounded monthly
      const result = FinancialMath.compoundInterest(1000, 5, 1, 12);
      expect(parseFloat(result.toFixed(2))).toBeGreaterThan(1051);
    });
  });

  describe('parse', () => {
    it('should parse currency string', () => {
      const result = FinancialMath.parse('$1,234.56');
      expect(result.toString()).toBe('1234.56');
    });

    it('should parse string with spaces', () => {
      const result = FinancialMath.parse('1 234.56');
      expect(result.toString()).toBe('1234.56');
    });

    it('should handle negative values', () => {
      const result = FinancialMath.parse('-$1,234.56');
      expect(result.toString()).toBe('-1234.56');
    });
  });

  describe('isZero', () => {
    it('should return true for zero', () => {
      expect(FinancialMath.isZero(0)).toBe(true);
      expect(FinancialMath.isZero('0')).toBe(true);
      expect(FinancialMath.isZero(new Decimal(0))).toBe(true);
    });

    it('should return false for non-zero', () => {
      expect(FinancialMath.isZero(1)).toBe(false);
      expect(FinancialMath.isZero(-1)).toBe(false);
      expect(FinancialMath.isZero(0.1)).toBe(false);
    });
  });

  describe('min', () => {
    it('should return minimum value', () => {
      const result = FinancialMath.min(3, 1, 4, 1, 5);
      expect(result.toString()).toBe('1');
    });

    it('should handle single value', () => {
      const result = FinancialMath.min(42);
      expect(result.toString()).toBe('42');
    });

    it('should handle mixed types', () => {
      const result = FinancialMath.min(3, '1', new Decimal('2'));
      expect(result.toString()).toBe('1');
    });

    it('should throw error for empty array', () => {
      expect(() => FinancialMath.min()).toThrow('Cannot get minimum of empty array');
    });
  });

  describe('max', () => {
    it('should return maximum value', () => {
      const result = FinancialMath.max(3, 1, 4, 1, 5);
      expect(result.toString()).toBe('5');
    });

    it('should handle single value', () => {
      const result = FinancialMath.max(42);
      expect(result.toString()).toBe('42');
    });

    it('should handle mixed types', () => {
      const result = FinancialMath.max(3, '5', new Decimal('2'));
      expect(result.toString()).toBe('5');
    });

    it('should throw error for empty array', () => {
      expect(() => FinancialMath.max()).toThrow('Cannot get maximum of empty array');
    });
  });

  describe('edge cases and precision', () => {
    it('should maintain precision with floating point operations', () => {
      // This would be 0.30000000000000004 with native JavaScript
      const result = FinancialMath.add(0.1, 0.2);
      expect(result.toString()).toBe('0.3');
    });

    it('should handle very large numbers', () => {
      const result = FinancialMath.add('999999999999999999.99', '0.01');
      expect(result.toString()).toBe('1000000000000000000');
    });

    it('should handle very small numbers', () => {
      const result = FinancialMath.add('0.00000001', '0.00000002');
      // Decimal.js uses scientific notation for very small numbers
      expect(result.toString()).toBe('3e-8');
    });
  });
});
