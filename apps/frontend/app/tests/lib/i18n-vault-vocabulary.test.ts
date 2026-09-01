import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * A Vault must never read as a strongbox, in any language (SC-810).
 *
 * The glossary singles this word out —
 * `apps/frontend/docs/src/content/docs/reference/glossary.md`, "Vault":
 * *"the single most dangerous word in the app for a crypto-literate
 * translator. It is not cold storage, not a smart contract, and not a custody
 * arrangement. 'Savings goal' is the meaning to translate."*
 *
 * It has now gone wrong twice. French shipped `Coffre`/`Coffres` — a
 * strongbox — across 46 leaves in two bundles, deployed, in a language nobody
 * was reading. And the Japanese contributor flagged their own correct
 * `貯蓄目標` as a contested rendering, believing `vault` meant cold storage,
 * which nearly blocked a good merge. The word misleads in both directions and
 * neither instance was caught by review.
 *
 * ## The check is keyed on the FORBIDDEN reading, never on an approved word
 *
 * The tempting guard is *"every locale must contain its goal-word"*. It is
 * wrong, and Russian is the proof: it renders Vault as `копилка` — a piggy
 * bank. That is a savings vessel with no custody or security reading, so it is
 * compliant, and a goal-word guard would call it a defect. A language may
 * solve this any way it likes; what it may not do is reach for the safe, the
 * strongbox, the vault-in-the-bank sense.
 *
 * ## Scoped to vault strings, because a bundle-wide sweep reds on correct text
 *
 * `v3.capture.page.wallet.namePlaceholder` is *"Cold storage, Trading
 * wallet…"* in English and `コールドウォレット、取引用ウォレット…` in
 * Japanese. Both are correct: they name a WALLET, where cold storage is
 * exactly the right phrase. A bundle-wide check flags them, and the remedy its
 * message implies — remove the offending words — looks like a fix while
 * breaking a correct string.
 *
 * ## Adding a language means declaring its strongbox vocabulary
 *
 * `FORBIDDEN` is keyed by locale and a locale with no entry fails, rather than
 * passing unexamined. A guard that silently skips the language nobody has
 * looked at is the shape that produced this defect.
 */

const SHELL = resolve(import.meta.dir, '../../src/i18n/locales');
const V3 = resolve(import.meta.dir, '../../src/v3/i18n/locales');
const TREES: readonly (readonly [string, string])[] = [
  ['shell', SHELL],
  ['v3', V3],
];

/**
 * The strongbox / custody reading, per language. These are the words that
 * would make a reader believe the feature holds or secures their assets.
 *
 * Kept as plain literals so `grep` finds every one of them, and deliberately
 * NOISY rather than precise: this sweeps prose whose form we do not control,
 * and a pattern tight enough to avoid false positives is tight enough to miss
 * the instance phrased in a shape nobody anticipated. The scoping above is
 * what keeps the noise down, not the tightness of these.
 */
const FORBIDDEN: Record<string, RegExp> = {
  en: /\b(strongbox|safe[- ]?deposit|cold storage|custody|custodian|vault door)\b/i,
  es: /(caja fuerte|cofre|bóveda|boveda|custodia|almacenamiento en frío)/i,
  // `garde` alone is NOT here on purpose. It matches six correct strings in
  // this very bundle — `Garde {{count}} transferts hors de la file`,
  // `v3.review.rules.row.hiding_*` — and `sauvegarde`. Only the scoping keeps
  // a bare `garde` quiet today, and a pattern that reds on correct copy
  // recruits its reader to break it. Custody in French is a phrase.
  fr: /(coffre|chambre forte|sous garde|garde des actifs|dépositaire|entiercement|(conservation|stockage) à froid)/i,
  // `simpanan` and `tabungan` are NOT here: Indonesian renders Vault as
  // `target tabungan`, a savings goal, so a pattern reaching for the ordinary
  // words for savings would red on every correct string in the bundle.
  // `penitipan` is the custody sense specifically — the safekeeping a
  // custodian does, not the everyday verb for leaving something with someone.
  id: /(brankas|lemari besi|peti besi|khazanah|kustodi|penitipan|safe deposit|(penyimpanan|dompet) dingin|cold (storage|wallet))/i,
  ja: /(金庫|保管庫|コールドウォレット|コールドストレージ|カストディ)/,
  pt: /(cofre|caixa-forte|custódia|custodia|armazenamento a frio)/i,
  ru: /(сейф|хранилищ|банковск\w*\s+ячейк|холодн\w*\s+хранени)/i,
  // `保管` alone is NOT here: it is the ordinary verb for keeping something,
  // and `保管库` is the strongbox reading. Chinese renders Vault as 储蓄目标,
  // a savings goal, which shares no character with any of these.
  zh: /(金库|保险库|保险柜|保险箱|保管库|保管箱|冷存储|冷钱包|冷藏|托管)/,
};

type Leaf = readonly [string, string];

function leaves(node: unknown, prefix = ''): Leaf[] {
  if (typeof node === 'string') return [[prefix, node] as const];
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
}

function bundle(dir: string, code: string): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(join(dir, `${code}.json`), 'utf8'));
  return Object.fromEntries(leaves(parsed));
}

function codes(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'incomplete-locales.json')
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

const EN_NAMES_A_VAULT = /\bvaults?\b/i;

/**
 * Whether a key is a Vault string.
 *
 * Two clauses, and both earn their place. The key path catches
 * `ui.dataView.noun.vaults_many`, which has no English counterpart at all
 * because English has no `_many` form. The English VALUE catches
 * `v3.settings.account.deleteIntro` and its two siblings, which enumerate
 * "…group and vault" inside a settings string whose key says nothing about
 * vaults — three of the 46 French leaves, invisible to a key-name test.
 */
function isVaultString(key: string, english: string | undefined): boolean {
  if (key.toLowerCase().includes('vault')) return true;
  return english !== undefined && EN_NAMES_A_VAULT.test(english);
}

/** The vault-scoped keys of `translations` whose text reads as a strongbox. */
function offendingKeys(
  code: string,
  english: Record<string, string>,
  translations: Record<string, string>
): string[] {
  const forbidden = FORBIDDEN[code];
  if (forbidden === undefined) throw new Error(`no strongbox vocabulary declared for "${code}"`);
  return Object.entries(translations)
    .filter(([key]) => isVaultString(key, english[key]))
    .filter(([, value]) => forbidden.test(value))
    .map(([key]) => key)
    .sort();
}

/** The denominator: how many strings the sweep above actually examined. */
function scopedCount(
  english: Record<string, string>,
  translations: Record<string, string>
): number {
  return Object.keys(translations).filter((key) => isVaultString(key, english[key])).length;
}

describe('vault vocabulary', () => {
  test('every locale on disk declares its strongbox vocabulary', () => {
    const undeclared = TREES.flatMap(([, dir]) => codes(dir))
      .filter((code) => FORBIDDEN[code] === undefined)
      .sort();
    expect(undeclared).toEqual([]);
  });

  for (const [tree, dir] of TREES) {
    for (const code of codes(dir)) {
      test(`${tree}/${code}: no vault string reads as a strongbox`, () => {
        const english = bundle(dir, 'en');
        const translations = bundle(dir, code);

        // Must-be-FOUND arm. An absence assertion passes vacuously over an
        // empty population, and an empty population is exactly what a renamed
        // key namespace or a mis-scoped predicate produces. Assert the sweep
        // saw something before believing it saw nothing wrong.
        expect(scopedCount(english, translations)).toBeGreaterThan(10);

        expect(offendingKeys(code, english, translations)).toEqual([]);
      });
    }
  }

  /**
   * The must-be-FOUND arm on the PATTERNS themselves. The test above proves
   * the sweep reaches a non-empty population; it cannot prove that any of the
   * seven regexes is capable of matching anything, and a pattern that matches
   * nothing produces the same clean run as a compliant bundle.
   *
   * These run through `offendingKeys`, not through a copy of it, so a change
   * to the scoping or the matching is exercised by both arms at once.
   */
  test('each language pattern fires on a planted strongbox rendering', () => {
    const planted: Record<string, string> = {
      en: 'A vault is a strongbox for your holdings.',
      es: 'Un objetivo es una caja fuerte para tus posiciones.',
      fr: 'Un objectif est un coffre-fort pour vos positions.',
      id: 'Target tabungan adalah brankas untuk posisi Anda.',
      ja: '貯蓄目標は保有資産の金庫です。',
      pt: 'Um objetivo é um cofre para as suas posições.',
      ru: 'Копилка — это сейф для ваших активов.',
      zh: '储蓄目标是存放你持仓的金库。',
    };
    const english = { 'v3.vaults.page.title': 'Vaults' };

    const caught = Object.entries(planted)
      .filter(([code, text]) => {
        return offendingKeys(code, english, { 'v3.vaults.page.title': text }).length === 1;
      })
      .map(([code]) => code)
      .sort();

    expect(caught).toEqual(Object.keys(FORBIDDEN).sort());
  });

  /**
   * The must-be-ABSENT arm on the SCOPING. `Cold storage, Trading wallet…` is
   * a correct English wallet placeholder that the `en` pattern matches, and
   * `コールドウォレット` is its correct Japanese counterpart. Both stay quiet
   * only because they are not vault strings — so if this ever goes red, the
   * check has been widened into flagging correct copy.
   */
  test('a correct wallet placeholder is out of scope, not merely unmatched', () => {
    const key = 'v3.capture.page.wallet.namePlaceholder';
    const english = { [key]: 'Cold storage, Trading wallet…' };

    // The pattern itself matches it — this is scoping doing the work.
    expect(FORBIDDEN.en?.test(english[key] ?? '')).toBe(true);
    expect(isVaultString(key, english[key])).toBe(false);

    expect(offendingKeys('en', english, english)).toEqual([]);
    expect(
      offendingKeys('ja', english, { [key]: 'コールドウォレット、取引用ウォレット…' })
    ).toEqual([]);
  });
});
