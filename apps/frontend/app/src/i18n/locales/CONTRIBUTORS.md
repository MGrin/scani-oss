# Adding a translation

The SPA's UI strings live in **two** directories, one JSON file per
language in each:

| Directory | Holds | Ships |
|---|---|---|
| `src/i18n/locales/` (here) | `$meta`, `nav`, `dashboard`, `settings`, `ui` | in the entry bundle |
| `src/v3/i18n/locales/` | everything under `v3` | with the v3 interface |

`en.json` is the source of truth in both — every other locale is a
translation of it, and missing keys fall back to English at runtime so
a partial translation never breaks the UI.

**Why two.** The v3 interface is a separately downloaded chunk, and its
strings are 65 KB of the file they used to share. Keeping them together
meant every visitor — including one who only ever sees the sign-in form
— downloaded all 1062 of them before anything appeared on screen.
`tests/lib/i18n-locales.test.ts` keeps the two directories in step, so
a mistake here fails the build rather than shipping.

## How to add a new locale

1. Pick an [ISO 639-1 code](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes)
   for your language (`es` for Spanish, `fr` for French, `de` for
   German, `pt-BR` for Brazilian Portuguese, …).
2. Copy **both** `en.json` files to `<code>.json` — this directory and
   `src/v3/i18n/locales/`. A locale present in only one of them fails
   the build.
3. Translate the **values** — leave the keys (`dashboard.title`,
   `nav.holdings`, …) untouched. Translate the `$meta.name` and
   `$meta.nativeName` fields so the language picker shows your locale
   correctly (e.g. `"name": "Spanish"`, `"nativeName": "Español"`).
4. **Add the design-system strings — copying `en.json` does not give
   you these.** `@scani/ui` ships the toasts, the error screens, the
   export and refine sheets and the loading states, and its own
   `packages/frontend/ui/src/i18n/locales/en.json` *is* the English —
   which is why the English file here does not carry them and a copy of
   it cannot either. Every other language reaches the design system by
   putting those `ui.*` keys in the file **here**, which the app
   forwards into the package at boot. There are 186 of them; leave them
   out and the interface reverts to English on every toast and every
   error, which is where a reader is least able to guess.
5. **Add the plural forms your language has, which English does not.**
   English has two categories, `_one` and `_other`. French, Spanish and
   Portuguese have three; Russian has four; Arabic has six; Chinese,
   Japanese and Indonesian have one. A key ending `_one` in `en.json`
   needs one entry per category in yours. Ask the runtime rather than
   guessing — it is the same source the test checks against:

   ```sh
   bun -e "console.log(new Intl.PluralRules('fr').resolvedOptions().pluralCategories)"
   ```

6. Run the SPA locally (`bun run dev` from the repo root, then open
   `http://localhost:5173`) and pick your language from
   **Settings → Preferences → Language**. You can also force a locale
   for one page load with `?lng=<code>` in the URL.
7. If you are sending a **partial** translation, add your language to
   `src/i18n/incomplete-locales.json` with a one-line reason. See
   "Partial translations are fine" below — this is the one other file
   you may need to touch.
8. Open a PR. CI will run type-check + lint; the build auto-discovers
   every `*.json` in both directories, so nothing else needs changing.

## What you do not need to translate

- Keys that begin with `$` (e.g. `$meta`) — these are metadata, not
  UI strings.
- Brand names ("Scani"), provider names ("CoinGecko", "Binance"),
  ticker symbols, units, ISO currency codes.

## Partial translations are fine

A locale with only `nav.*` translated is a valid PR. Untranslated keys
fall back to English at runtime, so a partial translation never breaks
the UI. Send what you have; the next contributor (or you, in another
PR) can fill in the rest.

**Say so, though.** Add your language to
`src/i18n/incomplete-locales.json`:

```json
{
  "incomplete": {
    "es": "Started 2026-09-01, nav and settings done, v3 in progress."
  }
}
```

That one line is the whole ceremony, and it is what keeps the door open
for you: a language *not* listed there has to answer every key `en.json`
defines, and `tests/lib/i18n-locales.test.ts` fails with the missing
keys listed by name if it does not.

**Why the rule exists at all.** Russian shipped complete on 2026-08-18
and was 50 keys behind by the same evening — two unrelated PRs added
English strings and nobody noticed, because English fallback is the
designed behaviour and nothing failed. A Russian reader got an English
sentence in the middle of a paragraph, and every test stayed green
(SC-409). The check is not there to keep partial translations out; it
is there so a language that *was* finished cannot quietly stop being
finished.

**Take your language back out of the file when you finish.** The test
also fails on a listed locale that has caught up, so a stale entry
cannot sit there covering the next 50 keys to go missing.

## Questions

If you are unsure how a particular string should be translated in
context, open the PR anyway and ask in the description — maintainers
will help you find the right surface in the UI.
