import { importChunk } from '@scani/ui/lib/lazy-chunk';
import type { i18n as I18n } from 'i18next';
import { HELD_LANGUAGES, isOfferedLanguage } from './offered-languages';

type Bundle = Record<string, unknown>;
export type LocaleLoader = () => Promise<{ default: Bundle }>;

/**
 * Locales on demand (SC-1498).
 *
 * Every locale used to ship in the chunk that registered it: nine languages,
 * 273 KB brotli against English's 31 KB, 46% of the signed-in chunk, downloaded
 * by a reader who will see one of them. English stays bundled because it is the
 * fallback every missing key resolves to; the rest arrive when they are the
 * reader's language or when the reader picks them.
 *
 * Two chunks each carry half of a locale (SC-169), so a language is loaded
 * from every SOURCE that has registered by then, and a source that registers
 * later brings its own half with it.
 *
 * **A language is only ever switched to after its strings are in.** `change`
 * awaits the load before `changeLanguage`, so no render sees the new language
 * with an empty bundle. A fetch that fails rejects with `ChunkLoadError` and
 * leaves the language where it was.
 */
export interface LocaleLoaderHandle {
  /** Add a chunk's lazy locales, keyed by language code. */
  register(loaders: Readonly<Record<string, LocaleLoader>>): void;
  /** Load `code` from every registered source that has it. */
  ensure(code: string): Promise<void>;
  /** The reader's language, as the first detected code any source can load. */
  active(): string | undefined;
  /** Load, then switch. */
  change(code: string): Promise<void>;
}

/**
 * `./locales/ru.json` -> `ru`, held languages dropped (SC-201). This is the
 * only door a locale file reaches a chunk's loaders through, so a held
 * language is never registered, offered or fetched. `held` is a parameter for
 * the reason it is one on `isOfferedLanguage`: the rule stays testable while
 * the set is empty.
 */
export function loadersByCode(
  modules: Readonly<Record<string, LocaleLoader>>,
  held: ReadonlySet<string> = HELD_LANGUAGES
): Record<string, LocaleLoader> {
  const out: Record<string, LocaleLoader> = {};
  for (const [path, load] of Object.entries(modules)) {
    const code = path.replace(/^.*\//, '').replace(/\.json$/, '');
    if (isOfferedLanguage(code, held)) out[code] = load;
  }
  return out;
}

export function createLocaleLoader(i18n: I18n): LocaleLoaderHandle {
  const sources: Array<Readonly<Record<string, LocaleLoader>>> = [];
  const inFlight = new Map<LocaleLoader, Promise<void>>();

  const load = (code: string, loader: LocaleLoader): Promise<void> => {
    const pending = inFlight.get(loader);
    if (pending) return pending;
    const started = importChunk(loader, { chunk: `language (${code})` }).then(
      (mod) => {
        const { $meta: _meta, ...translation } = mod.default;
        // Deep-merge, and do not overwrite: the other source's half of this
        // language may already be registered.
        i18n.addResourceBundle(code, 'translation', translation, true, false);
      },
      (error) => {
        // Forgotten, so the next attempt issues a new request.
        inFlight.delete(loader);
        throw error;
      }
    );
    inFlight.set(loader, started);
    return started;
  };

  const ensure = async (code: string): Promise<void> => {
    await Promise.all(
      sources.flatMap((source) => {
        const loader = source[code];
        return loader ? [load(code, loader)] : [];
      })
    );
  };

  return {
    register: (loaders) => {
      sources.push(loaders);
    },
    ensure,
    active: () => (i18n.languages ?? []).find((code) => sources.some((source) => source[code])),
    change: async (code) => {
      await ensure(code);
      await i18n.changeLanguage(code);
    },
  };
}
