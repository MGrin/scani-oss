import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccountDeleteAction } from '../../../src/v3/components/entities/AccountDeleteAction';

/**
 * SC-1746. One account deletes from its own peek, behind the inline confirm
 * every other v3 delete uses (SC-73). There is no DOM here, so the resting
 * frame is asserted to carry nothing that can be the write, and the sentence
 * the open frame shows is asserted against the English the product ships.
 */

const t = i18n.t.bind(i18n);

describe('AccountDeleteAction', () => {
  test('rests as the trigger alone — no commit, no consequence, no write', () => {
    let deleted = 0;
    const html = renderToStaticMarkup(
      <AccountDeleteAction name="Kraken Spot" onDelete={() => deleted++} />
    );
    expect(html).toContain('Delete');
    expect(html).not.toContain('Delete Kraken Spot');
    expect(html).not.toContain('cannot be undone');
    expect(html).not.toContain('Cancel');
    expect(deleted).toBe(0);
  });

  test('the commit names the account, so it is not labelled like the trigger', () => {
    expect(t('v3.entities.account.deleteAction.commit', { name: 'Kraken Spot' })).toBe(
      'Delete Kraken Spot'
    );
    expect(t('v3.entities.account.deleteAction.trigger')).toBe('Delete');
  });

  /**
   * The three things the reader cannot see from the sheet, each stated: the
   * chart's past changes, the realized gains go, and there is no way back.
   */
  test('the consequence states the chart, the realized gains and the finality', () => {
    const sentence = t('v3.entities.account.deleteAction.consequence', { name: 'Kraken Spot' });
    expect(sentence).toContain('Kraken Spot');
    expect(sentence).toContain('every past day of your net worth chart');
    expect(sentence).toContain('realized gains');
    expect(sentence).toContain('cannot be undone');
  });
});
