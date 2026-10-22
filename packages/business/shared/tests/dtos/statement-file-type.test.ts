import { describe, expect, test } from 'bun:test';
import { statementFormatLabel } from '../../src/dtos/statement-file-type.dto';

// SC-1726. The job page printed the stored value in capitals, so a CAMT.053
// import was headed "CAMT053 file" under a form that had just called it
// CAMT.053.

describe('statementFormatLabel', () => {
  test('a format is written the way its standard writes it', () => {
    expect(statementFormatLabel('camt053')).toBe('CAMT.053');
    expect(statementFormatLabel('mt940')).toBe('MT940');
  });

  test('CONTROL: the older formats read as they always did', () => {
    expect(['csv', 'ofx', 'qif'].map(statementFormatLabel)).toEqual(['CSV', 'OFX', 'QIF']);
  });
});
