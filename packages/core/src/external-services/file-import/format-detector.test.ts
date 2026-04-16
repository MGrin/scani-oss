import { describe, expect, it } from 'bun:test';
import { detectBankTemplate, detectFormat, isInteractiveBrokersCsv } from './format-detector';

describe('detectFormat', () => {
  it('should detect CSV by extension', () => {
    expect(detectFormat('data', 'statement.csv')).toBe('csv');
  });

  it('should detect PDF by extension', () => {
    expect(detectFormat('data', 'statement.pdf')).toBe('pdf');
  });

  it('should detect QIF by extension', () => {
    expect(detectFormat('data', 'export.qif')).toBe('qif');
  });

  it('should detect QIF by content (!Type:)', () => {
    expect(detectFormat('!Type:Bank\nD12/03/2026\nT-50.00', undefined)).toBe('qif');
  });

  it('should detect IB CSV by extension + content', () => {
    const ibContent =
      'Statement,Header,Field Name,Field Value\nStatement,Data,BrokerName,Interactive Brokers LLC';
    expect(detectFormat(ibContent, 'U7324249.csv')).toBe('ib-csv');
  });

  it('should detect TSV by extension', () => {
    expect(detectFormat('data', 'statement.tsv')).toBe('csv');
  });

  it('should detect OFX by extension', () => {
    expect(detectFormat('data', 'bank.ofx')).toBe('ofx');
  });

  it('should detect QFX by extension', () => {
    expect(detectFormat('data', 'quicken.qfx')).toBe('ofx');
  });

  it('should detect MT940 by extension', () => {
    expect(detectFormat('data', 'statement.sta')).toBe('mt940');
    expect(detectFormat('data', 'statement.mt940')).toBe('mt940');
  });

  it('should detect OFX by content (OFXHEADER)', () => {
    expect(detectFormat('OFXHEADER:100\nDATA:OFXSGML', undefined)).toBe('ofx');
  });

  it('should detect OFX by content (<OFX>)', () => {
    expect(detectFormat('<?xml version="1.0"?><OFX>', undefined)).toBe('ofx');
  });

  it('should detect MT940 by content (:20:)', () => {
    expect(detectFormat(':20:TRANSREF\n:25:ACCOUNT', undefined)).toBe('mt940');
  });

  it('should detect CSV by comma content', () => {
    expect(detectFormat('date,amount,desc', undefined)).toBe('csv');
  });

  it('should detect CSV by semicolon content', () => {
    expect(detectFormat('date;amount;desc', undefined)).toBe('csv');
  });

  it('should return null for unrecognizable content', () => {
    expect(detectFormat('just plain text', undefined)).toBe(null);
  });
});

describe('detectBankTemplate', () => {
  it('should detect Revolut headers', () => {
    expect(
      detectBankTemplate(['Started Date', 'Description', 'Amount', 'Currency', 'Balance'])
    ).toBe('revolut');
  });

  it('should detect Tinkoff headers', () => {
    expect(
      detectBankTemplate(['Дата операции', 'Описание', 'Сумма операции', 'Валюта операции'])
    ).toBe('tinkoff');
  });

  it('should detect Sberbank headers', () => {
    expect(detectBankTemplate(['Дата', 'Описание операции', 'Сумма', 'Валюта'])).toBe('sberbank');
  });

  it('should detect Wise headers', () => {
    expect(
      detectBankTemplate(['Date', 'Description', 'Amount', 'Currency', 'Running Balance'])
    ).toBe('wise');
  });

  it('should detect Monzo headers', () => {
    expect(
      detectBankTemplate([
        'Transaction ID',
        'Date',
        'Time',
        'Type',
        'Name',
        'Emoji',
        'Category',
        'Amount',
        'Currency',
      ])
    ).toBe('monzo');
  });

  it('should return null for unknown headers', () => {
    expect(detectBankTemplate(['Col1', 'Col2', 'Col3'])).toBe(null);
  });
});

describe('isInteractiveBrokersCsv', () => {
  it('should detect IB CSV content', () => {
    const content =
      'Statement,Header,Field Name,Field Value\nStatement,Data,BrokerName,Interactive Brokers LLC';
    expect(isInteractiveBrokersCsv(content)).toBe(true);
  });

  it('should not match regular CSV', () => {
    expect(isInteractiveBrokersCsv('Date,Amount,Description\n2024-01-01,100,test')).toBe(false);
  });
});
