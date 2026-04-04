import { describe, expect, it } from 'bun:test';
import { detectBankTemplate, detectFormat } from './format-detector';

describe('detectFormat', () => {
  it('should detect CSV by extension', () => {
    expect(detectFormat('data', 'statement.csv')).toBe('csv');
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

  it('should return null for unknown headers', () => {
    expect(detectBankTemplate(['Col1', 'Col2', 'Col3'])).toBe(null);
  });
});
