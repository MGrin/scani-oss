import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import ar from '../../../src/v3/i18n/locales/ar.json';
import en from '../../../src/v3/i18n/locales/en.json';
import es from '../../../src/v3/i18n/locales/es.json';
import fr from '../../../src/v3/i18n/locales/fr.json';
import id from '../../../src/v3/i18n/locales/id.json';
import ja from '../../../src/v3/i18n/locales/ja.json';
import pt from '../../../src/v3/i18n/locales/pt.json';
import ru from '../../../src/v3/i18n/locales/ru.json';
import zh from '../../../src/v3/i18n/locales/zh.json';

const LOCALES = { ar, en, es, fr, id, ja, pt, ru, zh };

// SC-1734. An XLSX or XLS whose headers no template knows reaches the same
// column-mapping step a CSV does, so its title cannot name CSV.
describe('the column-mapping step', () => {
  test('names no file format, in any locale', () => {
    for (const [locale, messages] of Object.entries(LOCALES)) {
      expect({ locale, title: messages.v3.jobs.file.columns.title }).not.toEqual({
        locale,
        title: expect.stringMatching(/CSV/),
      });
    }
  });
});
