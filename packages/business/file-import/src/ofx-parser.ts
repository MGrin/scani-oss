// @ts-expect-error — ofx-js (CommonJS) ships no type declarations
import ofx from 'ofx-js';
import type { ParsedTransaction, ParseResult } from './types';

/**
 * Parse an OFX/QFX bank statement into normalized transactions.
 *
 * OFX (Open Financial Exchange) is a standard format supported by most
 * US, Canadian, and European banks. QFX is Quicken's variant of OFX.
 */
export async function parseOfxStatement(content: string): Promise<ParseResult> {
  const warnings: string[] = [];

  try {
    const parsed = await ofx.parse(content);

    const transactions: ParsedTransaction[] = [];
    let detectedCurrency: string | undefined;

    // Navigate OFX structure: OFX > BANKMSGSRSV1 > STMTTRNRS > STMTRS
    const bankMsgs = parsed?.OFX?.BANKMSGSRSV1;
    const stmtTrnRs = bankMsgs?.STMTTRNRS;
    const stmtRs = stmtTrnRs?.STMTRS;

    if (stmtRs) {
      detectedCurrency = stmtRs.CURDEF;

      // Parse transactions from BANKTRANLIST
      const tranList = stmtRs.BANKTRANLIST;
      const stmtTrns = tranList?.STMTTRN;

      if (stmtTrns) {
        const txns = Array.isArray(stmtTrns) ? stmtTrns : [stmtTrns];

        for (const txn of txns) {
          try {
            const amount = Number.parseFloat(txn.TRNAMT || '0');
            const dateStr = txn.DTPOSTED || '';
            const date = parseOfxDate(dateStr);
            const description = txn.NAME || txn.MEMO || txn.TRNTYPE || 'Unknown';

            transactions.push({
              date,
              description,
              amount,
              currency: detectedCurrency || '',
            });
          } catch (e) {
            warnings.push(`Transaction parse error: ${e instanceof Error ? e.message : 'unknown'}`);
          }
        }
      }
    }

    // Also check credit card statements (CREDITCARDMSGSRSV1)
    const ccMsgs = parsed?.OFX?.CREDITCARDMSGSRSV1;
    const ccTrnRs = ccMsgs?.CCSTMTTRNRS;
    const ccStmtRs = ccTrnRs?.CCSTMTRS;

    if (ccStmtRs) {
      if (!detectedCurrency) detectedCurrency = ccStmtRs.CURDEF;

      const ccTranList = ccStmtRs.BANKTRANLIST;
      const ccStmtTrns = ccTranList?.STMTTRN;

      if (ccStmtTrns) {
        const txns = Array.isArray(ccStmtTrns) ? ccStmtTrns : [ccStmtTrns];

        for (const txn of txns) {
          try {
            const amount = Number.parseFloat(txn.TRNAMT || '0');
            const date = parseOfxDate(txn.DTPOSTED || '');
            const description = txn.NAME || txn.MEMO || 'Unknown';

            transactions.push({
              date,
              description,
              amount,
              currency: detectedCurrency || '',
            });
          } catch (e) {
            warnings.push(
              `CC transaction parse error: ${e instanceof Error ? e.message : 'unknown'}`
            );
          }
        }
      }
    }

    if (transactions.length === 0) {
      warnings.push('No transactions found in OFX file');
    }

    return {
      transactions,
      holdings: [],
      format: 'ofx',
      detectedCurrency,
      warnings,
    };
  } catch (error) {
    return {
      transactions: [],
      holdings: [],
      format: 'ofx',
      warnings: [
        `Failed to parse OFX: ${error instanceof Error ? error.message : 'unknown error'}`,
      ],
    };
  }
}

/** Parse OFX date format: YYYYMMDDHHMMSS or YYYYMMDD */
function parseOfxDate(dateStr: string): Date {
  // OFX dates: 20240315120000 or 20240315
  const clean = dateStr.replace(/\[.*\]/, '').trim();
  const year = clean.substring(0, 4);
  const month = clean.substring(4, 6);
  const day = clean.substring(6, 8);

  if (!year || !month || !day) {
    throw new Error(`Invalid OFX date: ${dateStr}`);
  }

  return new Date(`${year}-${month}-${day}`);
}
