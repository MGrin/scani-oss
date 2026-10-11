import Papa from 'papaparse';
import { type ActualRegisterParse, parseActualRegister } from './actual-register';
import type { DateOrder } from './dates';
import { type MintRegisterParse, parseMintRegister } from './mint-register';
import { parseYnabRegister, type YnabRegisterParse } from './ynab-register';

export type BudgetAppName = 'ynab' | 'actual' | 'mint';
export type BudgetAppRegisterParse = YnabRegisterParse | ActualRegisterParse | MintRegisterParse;

/** Which app wrote the file, read from its header row; null when neither did. */
export function detectBudgetApp(text: string): BudgetAppName | null {
  const { meta } = Papa.parse(text.replace(/^﻿/, ''), {
    header: true,
    preview: 1,
    delimiter: '',
    transformHeader: (h) => h.replace(/^﻿/, '').trim(),
  });
  const headers = new Set(meta.fields ?? []);
  if (headers.has('Outflow') && headers.has('Inflow')) return 'ynab';
  if (headers.has('Transaction Type') && headers.has('Account Name')) return 'mint';
  if (headers.has('Account') && headers.has('Amount') && headers.has('Notes')) return 'actual';
  return null;
}

export function parseBudgetAppRegister(
  text: string,
  app: BudgetAppName,
  dateOrder?: DateOrder
): BudgetAppRegisterParse {
  if (app === 'ynab') return parseYnabRegister(text, dateOrder);
  return app === 'actual' ? parseActualRegister(text) : parseMintRegister(text);
}
