# Adding a translation

The SPA's UI strings live in this directory as JSON files, one per
language. `en.json` is the source of truth — every other locale is a
translation of it, and missing keys fall back to English at runtime so
a partial translation never breaks the UI.

## How to add a new locale

1. Pick an [ISO 639-1 code](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes)
   for your language (`es` for Spanish, `fr` for French, `de` for
   German, `pt-BR` for Brazilian Portuguese, …).
2. Copy `en.json` to `<code>.json` in this directory.
3. Translate the **values** — leave the keys (`dashboard.title`,
   `nav.holdings`, …) untouched. Translate the `$meta.name` and
   `$meta.nativeName` fields so the language picker shows your locale
   correctly (e.g. `"name": "Spanish"`, `"nativeName": "Español"`).
4. Run the SPA locally (`bun run dev` from the repo root, then open
   `http://localhost:5173`) and pick your language from
   **Settings → Preferences → Language**. You can also force a locale
   for one page load with `?lng=<code>` in the URL.
5. Open a PR. CI will run type-check + lint; you don't need to touch
   any other file — the build auto-discovers every `*.json` in this
   directory.

## What you do not need to translate

- Keys that begin with `$` (e.g. `$meta`) — these are metadata, not
  UI strings.
- Brand names ("Scani"), provider names ("CoinGecko", "Binance"),
  ticker symbols, units, ISO currency codes.

## Partial translations are fine

A locale with only `nav.*` translated is a valid PR. Untranslated keys
fall back to English at runtime — there is no hard "must be 100%
complete" gate. Send what you have; the next contributor (or you, in
another PR) can fill in the rest.

## Questions

If you are unsure how a particular string should be translated in
context, open the PR anyway and ask in the description — maintainers
will help you find the right surface in the UI.
