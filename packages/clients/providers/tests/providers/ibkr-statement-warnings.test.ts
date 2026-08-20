import { describe, expect, test } from 'bun:test';
import {
  BALANCE_SECTIONS,
  describeMissingSections,
  describeUnmappedCashTypes,
  hasFlexSection,
  missingFlexSections,
  TRANSACTION_SECTIONS,
} from '../../src/providers/ibkr/statement-warnings';

/**
 * SC-435. Every IBKR transaction in production is a `<Trade>` — no dividend,
 * interest, deposit or withdrawal has ever arrived, while the cash plainly
 * moved. The parser handles all of them, so the rows are absent before we ever
 * see them, and a section the query never requested looked exactly like a
 * section with nothing in it.
 */
describe('hasFlexSection', () => {
  test('finds a section that has rows in it', () => {
    const xml =
      '<FlexStatement><CashTransactions><CashTransaction type="Dividends" /></CashTransactions></FlexStatement>';
    expect(hasFlexSection(xml, 'CashTransactions')).toBe(true);
  });

  test('finds a section that is present and EMPTY — the case that must stay quiet', () => {
    expect(hasFlexSection('<CashTransactions></CashTransactions>', 'CashTransactions')).toBe(true);
    expect(hasFlexSection('<CashTransactions/>', 'CashTransactions')).toBe(true);
    expect(hasFlexSection('<CashTransactions />', 'CashTransactions')).toBe(true);
  });

  test('a section that is simply not there is not there', () => {
    expect(hasFlexSection('<FlexStatement><Trades /></FlexStatement>', 'CashTransactions')).toBe(
      false
    );
  });

  /**
   * Each row element is a prefix of its own container, which is why this is a
   * lookahead and not a substring test. A statement whose rows arrived without
   * wrappers must not report the sections present — and, more importantly, a
   * statement full of `<CashReportCurrency>` rows must not be read as carrying
   * a `<CashReport>` it does not have.
   */
  test('a row element never counts as its own container', () => {
    expect(hasFlexSection('<CashTransaction type="Dividends" />', 'CashTransactions')).toBe(false);
    expect(hasFlexSection('<Trade tradeID="T-1" />', 'Trades')).toBe(false);
    expect(hasFlexSection('<OpenPosition symbol="AAPL" />', 'OpenPositions')).toBe(false);
    expect(hasFlexSection('<CashReportCurrency currency="USD" />', 'CashReport')).toBe(false);
  });

  test('the container still matches when its own rows are also present', () => {
    const xml = '<CashReport><CashReportCurrency currency="USD" endingCash="1" /></CashReport>';
    expect(hasFlexSection(xml, 'CashReport')).toBe(true);
  });
});

describe('missingFlexSections', () => {
  test('names only what is absent', () => {
    const xml = '<FlexStatement><Trades><Trade tradeID="T-1" /></Trades></FlexStatement>';
    const missing = missingFlexSections(xml, TRANSACTION_SECTIONS);

    expect(missing.map((s) => s.element)).toEqual(['CashTransactions']);
  });

  test('an empty statement is missing everything', () => {
    const missing = missingFlexSections('<FlexQueryResponse />', [
      ...BALANCE_SECTIONS,
      ...TRANSACTION_SECTIONS,
    ]);

    expect(missing.map((s) => s.element)).toEqual([
      'OpenPositions',
      'CashReport',
      'Trades',
      'CashTransactions',
    ]);
  });

  test('a complete statement is missing nothing', () => {
    const xml = '<OpenPositions /><CashReport /><Trades /><CashTransactions />';
    expect(missingFlexSections(xml, [...BALANCE_SECTIONS, ...TRANSACTION_SECTIONS])).toEqual([]);
  });
});

describe('describeMissingSections', () => {
  test('nothing missing says nothing', () => {
    expect(describeMissingSections([])).toBeNull();
  });

  test('the Cash Transactions case names the loss and the screen that fixes it', () => {
    const message = describeMissingSections(
      missingFlexSections('<Trades />', TRANSACTION_SECTIONS)
    );

    expect(message).toContain('"Cash Transactions" section');
    expect(message).toContain(
      'no dividends, interest, deposits, withdrawals or fees could be imported'
    );
    // A warning that names a problem without naming where the user fixes it
    // is a bug report, not a warning.
    expect(message).toContain('Flex Queries');
    expect(message).toContain('add it to your Flex Query');
    expect(message).not.toContain('"Trades"');
  });

  /**
   * It reports what the statement CONTAINED, not how the query is CONFIGURED.
   * We cannot see the query from here, and a user who has genuinely had no
   * cash activity would otherwise be told their setup is wrong.
   */
  test('it hedges rather than asserting the query is misconfigured', () => {
    const message = describeMissingSections(
      missingFlexSections('<Trades />', TRANSACTION_SECTIONS)
    );

    expect(message).toContain('carried no');
    expect(message).toContain('If you have had any');
  });

  test('two missing sections are one warning, not two', () => {
    const message = describeMissingSections(
      missingFlexSections('<AccountInformation accountId="U123" />', TRANSACTION_SECTIONS)
    );

    expect(message).toContain('"Trades" or "Cash Transactions" sections');
    expect(message).toContain('no buys or sells could be imported');
    expect(message).toContain('add them to your Flex Query');
  });
});

/**
 * The other door to the same symptom. `classifyCashType` matches IBKR's `type`
 * attribute exactly, so a category we have never seen drops real money out of
 * the ledger — and the reader cannot tell that from a section we never got.
 */
describe('describeUnmappedCashTypes', () => {
  test('nothing unmapped says nothing', () => {
    expect(describeUnmappedCashTypes(new Map())).toBeNull();
  });

  test('it names the type verbatim — the string IS the fix', () => {
    const message = describeUnmappedCashTypes(new Map([['Bond Interest Received', 3]]));

    expect(message).toContain('"Bond Interest Received" (3)');
    expect(message).toContain('3 cash transactions');
    expect(message).toContain('does not recognise');
  });

  test('singular reads as singular', () => {
    const message = describeUnmappedCashTypes(new Map([['Carbon Credits', 1]]));

    expect(message).toContain('1 cash transaction in this statement');
    expect(message).toContain('so it was not imported');
    expect(message).not.toContain('cash transactions');
  });

  /**
   * Unlike the missing-section warning, this one does NOT ask the user to go
   * and change anything — there is nothing they can change. Saying "check your
   * Flex Query" here would send them to fix a setting that is already correct.
   */
  test('it says whose problem it is, and does not send the user to IBKR', () => {
    const message = describeUnmappedCashTypes(new Map([['Something New', 1]]));

    expect(message).toContain('ours to fix, not yours');
    expect(message).not.toContain('Flex Queries');
  });

  test('most frequent first, and a long tail is summarized rather than listed', () => {
    const message = describeUnmappedCashTypes(
      new Map([
        ['A', 1],
        ['B', 9],
        ['C', 2],
        ['D', 3],
        ['E', 4],
        ['F', 5],
      ])
    );

    expect(message).toContain('"B" (9), "F" (5), "E" (4), "D" (3)');
    expect(message).toContain('and 2 further types');
    expect(message).toContain('24 cash transactions');
    expect(message).not.toContain('"A"');
  });
});
