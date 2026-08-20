/**
 * The strings an auth email is made of (SC-412).
 *
 * ## Why they live here and not in the SPA's `locales/`
 *
 * The letter is rendered by whoever *calls* the template — the api, inside the
 * request that asked for a sign-in link — and the data-provider only relays an
 * already-rendered `EmailMessage`. So the copy has to be reachable from a Bun
 * process with no DOM and no i18next, which the app's `src/i18n/locales/` is
 * not: it is discovered with `import.meta.glob`, a Vite build-time API that is
 * `undefined` outside the bundle.
 *
 * The alternative — the browser sending the rendered sentences up with the
 * request — was rejected for a reason worth stating: it lets the client choose
 * the words in a letter our domain signs, and a magic-link mail is the exact
 * message a phisher would like to write.
 *
 * ## The type is the completeness guard
 *
 * Every bundle is an `EmailStrings`, so a locale that omits a key does not
 * compile. That is deliberate and it is the whole of SC-412's third decision:
 * **a letter falls back to English WHOLE, never key by key.** i18next's
 * per-key fallback is right for a screen, where an English label among
 * Russian ones is a blemish; it is wrong for a letter, where it produces a
 * paragraph in one language and the sentence explaining it in another, in the
 * one message a new account receives before it has any reason to trust us.
 *
 * A language with no bundle therefore gets the English letter in full, and
 * `tests/i18n/app-languages.test.ts` fails when the app learns a language the
 * mail cannot speak — the silent-fallback shape SC-409 exists to stop, one
 * process further out.
 */

export interface EmailStrings {
  /** BCP-47 tag for `<html lang>`. Not a translation — the bundle's own name. */
  readonly lang: string;
  readonly layout: {
    /** `{appLink}` is an anchor, already escaped. */
    readonly footer: string;
    readonly tagline: string;
  };
  readonly common: {
    readonly orCopyUrl: string;
  };
  readonly magicLink: {
    readonly subject: string;
    readonly headline: string;
    readonly body: string;
    readonly button: string;
    readonly preheader: string;
    readonly textIntro: string;
    readonly textBody: string;
    readonly textIgnore: string;
  };
  readonly otp: {
    readonly headline: Record<OtpStringKey, string>;
    readonly purpose: Record<OtpStringKey, string>;
    /** The lowercase noun phrase the subject line is built from. A separate
     *  string rather than `headline.toLowerCase()`: case mapping is
     *  language-specific, and a headline is not a noun phrase in every
     *  language even where it is in English. */
    readonly subjectPurpose: Record<OtpStringKey, string>;
    readonly expiryHtml: string;
    readonly expiryText: string;
    readonly codeLabel: string;
    readonly tapCode: string;
    readonly preheaderSignIn: string;
    readonly preheaderVerification: string;
  };
  readonly verification: {
    readonly subject: string;
    readonly headline: string;
    readonly body: string;
    readonly button: string;
    readonly preheader: string;
    readonly textWelcome: string;
    readonly textBody: string;
    readonly textIgnore: string;
  };
}

/** The four OTP purposes, spelled as `OtpType` spells them minus the dashes. */
export type OtpStringKey = 'signIn' | 'emailVerification' | 'forgetPassword' | 'changeEmail';

/**
 * `{name}` substitution, and nothing else.
 *
 * No expressions, no plurals, no dates — an auth letter interpolates a product
 * name, a URL and a six-digit code, and every one of them is a bare value. A
 * template engine here would be a dependency and a syntax to get wrong.
 *
 * An unknown placeholder is left standing rather than blanked: `{code}` in a
 * subject line is a visible bug report, and an empty gap is a letter that
 * silently forgot the code.
 */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}
