import { describe, expect, test } from 'bun:test';
import { decodeProviderText } from '../../../src/lib/decode-provider-text';
import { ScamTokenDetectionService } from '../../../src/services/tokens/ScamTokenDetectionService';
import {
  asciiSkeleton,
  judgeSymbol,
  judgeTokenIdentity,
  nameHasBareHost,
  nameIsAttack,
  normalizeForDetection,
  scriptsOf,
} from '../../../src/services/tokens/token-identity-safety';

/**
 * SC-197. Every symbol below was found in production on Polygon, where
 ***REMOVED***
 * here in the exact characters that were in the database — if an editor
 * or a formatter ever "helpfully" normalises them, these tests fail,
 * which is the correct outcome.
 */
const PRODUCTION_LOOKALIKES: ReadonlyArray<{ symbol: string; presentsAs: string; note: string }> = [
  { symbol: 'EТH', presentsAs: 'ETH', note: 'Cyrillic Т' },
  { symbol: 'UЅDС', presentsAs: 'USDC', note: 'Cyrillic Ѕ and С' },
  { symbol: 'UЅDТ', presentsAs: 'USDT', note: 'Cyrillic Ѕ and Т' },
  { symbol: 'UЅDT', presentsAs: 'USDT', note: 'Cyrillic Ѕ only' },
  { symbol: 'ÚSDС', presentsAs: 'USDC', note: 'Ú plus Cyrillic С' },
  { symbol: 'ꓴꓢꓓC', presentsAs: 'USDC', note: 'Lisu' },
  { symbol: 'ꓴꓢꓓС', presentsAs: 'USDC', note: 'Lisu plus Cyrillic' },
];

/**
 * SC-220. These six are the population that broke, verbatim.
 *
 * The bare-TLD pattern matched a `.com` anywhere in a name, and
 * `judgeTokenIdentity` throws on `nameAttack` — so this was never a
 * script false positive that a guard could catch. **A user importing
 * Amazon from a broker had the token creation REFUSED.** IBKR supplies
 * full legal names, so this is the normal import path.
 *
 * The rule that admits all six while still refusing the production voucher
 * strings is the actual specification of `nameIsAttack`. Module-scoped
 * because SC-281 re-runs the same population through the widened detector.
 */
const LEGAL_NAMES_WITH_A_DOMAIN: readonly string[] = [
  'AMAZON.COM INC',
  'SALESFORCE.COM INC',
  'BOOKING.COM',
  'MATCH.COM',
  'PRICELINE.COM',
  'OVERSTOCK.COM',
];

describe('asciiSkeleton', () => {
  test('collapses every production lookalike onto the symbol it draws', () => {
    for (const { symbol, presentsAs, note } of PRODUCTION_LOOKALIKES) {
      expect(asciiSkeleton(symbol), `${symbol} (${note})`).toBe(presentsAs);
    }
  });

  test('leaves a real symbol alone', () => {
    expect(asciiSkeleton('USDC')).toBe('USDC');
    expect(asciiSkeleton('BRK.B')).toBe('BRK.B');
    expect(asciiSkeleton('1INCH')).toBe('1INCH');
  });

  /**
   * The case folding, which every fixture above is too uppercase to test —
   * found by a negative control that stayed green when `.toUpperCase()` was
   * removed (SC-281).
   *
   * It is not decoration: this is a comparison KEY, so a lowercase
   * impersonation has to collapse onto the same string as an uppercase one or
   * `lookalikeOf` reports `usdc` for one row and `USDC` for the next and
   * nothing groups them. SC-281 split this function into a folding half and a
   * casing half, which is exactly when an untested half goes missing.
   */
  test('the skeleton is case-folded, so a lowercase impostor collapses onto the same key', () => {
    expect(asciiSkeleton('uѕdс')).toBe('USDC');
    expect(asciiSkeleton('uѕdс')).toBe(asciiSkeleton('UЅDС'));
  });
});

describe('scriptsOf', () => {
  test('digits and punctuation are script-neutral, so real tickers read as one script', () => {
    expect(scriptsOf('BRK.B')).toEqual(['Latin']);
    expect(scriptsOf('1INCH')).toEqual(['Latin']);
  });

  test('a lookalike cannot avoid mixing scripts — it has to borrow a Latin letter', () => {
    expect(scriptsOf('UЅDС')).toEqual(['Cyrillic', 'Latin']);
    expect(scriptsOf('ꓴꓢꓓC')).toEqual(['Latin', 'Lisu']);
  });
});

describe('judgeSymbol', () => {
  test('flags every production lookalike AND names what it impersonates', () => {
    for (const { symbol, presentsAs, note } of PRODUCTION_LOOKALIKES) {
      const verdict = judgeSymbol(symbol);
      expect(verdict.lookalike, `${symbol} (${note})`).toBe(true);
      expect(verdict.lookalikeOf, `${symbol} (${note})`).toBe(presentsAs);
      expect(verdict.reasons.length).toBeGreaterThan(0);
    }
  });

  test('real symbols pass, including the shapes that look unusual', () => {
    for (const symbol of ['USDC', 'USDT', 'ETH', 'WETH', 'BRK.B', '1INCH', 'X', 'AAPL']) {
      const verdict = judgeSymbol(symbol);
      expect(verdict.lookalike, symbol).toBe(false);
      expect(verdict.lookalikeOf, symbol).toBeNull();
    }
  });

  /**
   * A symbol of genuinely non-Latin text is not impersonating anything —
   * it just is not ASCII. Claiming it "renders as X" would be a false
   * accusation dressed as a fact, so `lookalikeOf` stays null while the
   * symbol is still quarantined.
   */
  test('non-Latin text is quarantined but NOT accused of impersonating', () => {
    const verdict = judgeSymbol('比特币');
    expect(verdict.lookalike).toBe(true);
    expect(verdict.lookalikeOf).toBeNull();
  });

  /**
   * DOCUMENTED KNOWN FLAG — `USD₮` is Tether's own branding mark, and it
   * IS quarantined. That is deliberate. Do not "fix" it.
   *
   * `₮` is U+20AE, the Mongolian tugrik sign. `USD₮` is simultaneously a
   * legitimate Tether string and exactly the attack shape, because it
   * reads as "USDT" to any human. Quarantine costs a flag on a row that
   * still exists — which is the whole reason the design quarantines
   * instead of rejecting. Rejecting would have orphaned a genuine
   * Tether string's transactions.
   *
   * The tempting fix is to add `₮ → T` to CONFUSABLE_TO_ASCII so this
   * attributes to USDT instead of flagging anonymously. DO NOT. It would
   * make the system assert that Tether's own mark impersonates Tether —
   * a confident false statement — and, worse, it would COLLAPSE A
   * DISTINCTION THE CLASSIFIER CURRENTLY MAKES CORRECTLY. Today the
   * attack and the branding produce visibly different verdicts:
   *
   *   UЅDТ  (Cyrillic Ѕ + Т)  lookalikeOf='USDT', scripts=Cyrillic+Latin
   *   USD₮  (tugrik sign)     lookalikeOf=null,   scripts=Latin
   *
   * Adding the mapping gives them the same shape and destroys the only
   * signal that separates them. The anonymous flag is the honest answer:
   * this symbol is not plain ASCII, and we cannot say what it imitates.
   */
  test('a currency SIGN is flagged without attribution, unlike a lookalike LETTER', () => {
    const branding = judgeSymbol('USD₮');
    expect(branding.lookalike).toBe(true);
    expect(branding.lookalikeOf).toBeNull();
    expect(scriptsOf('USD₮')).toEqual(['Latin']);

    const attack = judgeSymbol('UЅDТ');
    expect(attack.lookalike).toBe(true);
    expect(attack.lookalikeOf).toBe('USDT');
    expect(scriptsOf('UЅDТ')).toEqual(['Cyrillic', 'Latin']);

    // The contrast is the assertion. If these two ever produce the same
    // verdict, the classifier has lost the ability to tell Tether's
    // branding from an impersonation of it.
    expect(branding.lookalikeOf).not.toBe(attack.lookalikeOf);
  });
});

describe('nameIsAttack', () => {
  test('the production phishing name', () => {
    expect(nameIsAttack('✅ SWAP YOUR VOUCHER ON T.LY/SHIBASWAP')).toBe(true);
  });

  /**
   * The imperative rule and the domain rule each catch cases the other
   * misses. Before `.ly` was added, the production row above was matched
   * ONLY by the imperative — by luck. These two cases exist so that
   * removing either rule fails a test rather than quietly narrowing
   * coverage.
   */
  test('a bare shortener has no imperative, and an imperative has no host', () => {
    expect(nameIsAttack('bit.ly/free-tokens')).toBe(true);
    expect(nameIsAttack('CLAIM YOUR REWARD NOW')).toBe(true);
  });

  test('real names pass, in any script', () => {
    for (const name of ['USD Coin', 'Wrapped Ether', 'Bitcoin', '比特币', 'Ethereum']) {
      expect(nameIsAttack(name), name).toBe(false);
    }
  });

  test('a company whose legal name contains a domain is not an attack', () => {
    for (const name of LEGAL_NAMES_WITH_A_DOMAIN) {
      expect(nameIsAttack(name), name).toBe(false);
    }
  });

  /**
   * The other half of the same specification, and the reason the fix is
   * "require a path" rather than "drop domain detection".
   *
   * `SWAP YOUR VOUCHER ON WR.DO/S/ETHER` scores 0.90 — UNDER the 0.95
   * admission gate — so the score alone would admit it and only the name
   * rule refuses it. Narrowing this rule is exactly how a name-attack
   * regression would enter, so both directions are asserted together:
   * every real name above admitted, every attack below still refused.
   */
  test('a host with somewhere to send you is still an attack', () => {
    for (const name of [
      '✅ SWAP YOUR VOUCHER ON T.LY/SHIBASWAP',
      'SWAP YOUR VOUCHER ON WR.DO/S/ETHER',
      'bit.ly/free-tokens',
      'Claim at example.com/airdrop',
      'tinyurl.com',
    ]) {
      expect(nameIsAttack(name), name).toBe(true);
    }
  });
});

describe('judgeTokenIdentity', () => {
  test('a name that is an instruction is a reject, not a quarantine', () => {
    const verdict = judgeTokenIdentity({
      symbol: 'VOUCHER',
      name: '✅ SWAP YOUR VOUCHER ON T.LY/SHIBASWAP',
    });
    expect(verdict.nameAttack).toBe(true);
    expect(verdict.quarantine).toBe(true);
  });

  /**
   * The rule the whole decision rests on: names may be any language,
   * symbols may not. Applying the symbol rule to names would reject
   * legitimate projects wholesale.
   */
  test('a non-ASCII NAME on an ASCII symbol is neither an attack nor a quarantine', () => {
    const verdict = judgeTokenIdentity({ symbol: 'HT', name: '比特币' });
    expect(verdict.nameAttack).toBe(false);
    expect(verdict.lookalike).toBe(false);
    expect(verdict.quarantine).toBe(false);
  });

  test('a lookalike symbol with a perfectly ordinary name is still quarantined', () => {
    const verdict = judgeTokenIdentity({ symbol: 'UЅDС', name: 'USD Coin' });
    expect(verdict.nameAttack).toBe(false);
    expect(verdict.quarantine).toBe(true);
    expect(verdict.lookalikeOf).toBe('USDC');
  });

  test('a missing name is not treated as an attack', () => {
    expect(judgeTokenIdentity({ symbol: 'USDC', name: null }).quarantine).toBe(false);
  });

  /**
   * SC-220, asserted at the gate rather than on the predicate.
   *
   * `TokenIdentityService` throws `ScamTokenRejectedError` when
   * `identityVerdict.nameAttack` is true, so THIS is the call that decided
   * six real equities could not be imported. The `nameIsAttack` tests
   * above would have kept passing if the verdict stopped consulting them,
   * and a test on the predicate cannot see the gate — which is the same
   * gap that let an unreachable code path ship once already.
   *
   * Symbol and name are both realistic here: these arrive from IBKR with a
   * plain ASCII ticker and the full legal name.
   */
  test('the ingest gate admits real equities whose legal name contains a domain', () => {
    for (const [symbol, name] of [
      ['AMZN', 'AMAZON.COM INC'],
      ['CRM', 'SALESFORCE.COM INC'],
      ['BKNG', 'BOOKING.COM'],
      ['MTCH', 'MATCH.COM'],
      ['PCLN', 'PRICELINE.COM'],
      ['OSTK', 'OVERSTOCK.COM'],
      ['AAPL', 'APPLE INC'],
      ['NVDA', 'NVIDIA CORP'],
    ] as ReadonlyArray<readonly [string, string]>) {
      const verdict = judgeTokenIdentity({ symbol, name });
      expect(verdict.nameAttack, `${symbol} ${name}`).toBe(false);
      expect(verdict.quarantine, `${symbol} ${name}`).toBe(false);
    }
  });

  /**
   * SC-224. The nine names the production sweep found, and the equities
   * they must be told apart from. This is the specification, and it is
   * asserted as ONE population because getting it wrong in either
   * direction has already shipped: SC-220 blocked six real imports,
   * SC-224 admitted seven live scam rows.
   *
   * Six of the scams are BARE HOSTS — no path, no shortener, nothing in
   * the string to distinguish them from `BOOKING.COM`. They are refused
   * only because the score is also elevated, which is why the score has
   * to reach `judgeTokenIdentity` at all.
   *
   * The scores below are the real ones, recomputed at creation time —
   * the same call `TokenIdentityService` makes.
   */
  const scamDetection = new ScamTokenDetectionService();
  const scoreAtCreation = (symbol: string, name: string): number =>
    scamDetection.calculateScamProbability(symbol, name, new Date('2020-01-01'));

  const PRODUCTION_NAME_ATTACKS: ReadonlyArray<readonly [string, string]> = [
    ['VOUCHER', '✅ SWAP YOUR VOUCHER ON T.LY/SHIBASWAP'],
    ['ETHER', 'SWAP YOUR VOUCHER ON WR.DO/S/ETHER'],
    ['HEX', '#HEXPool.net'],
    ['YF', 'yield-farming.io'],
    ['MW', '@ MetaWin.to'],
    ['DRAF', 'Draf.io'],
    ['EF2', 'EthFork2.com'],
    ['AIN', 'Aintiution.io'],
    ['DAO', 'dev dao giveaway'],
  ];

  test('every name the production sweep found is still refused', () => {
    for (const [symbol, name] of PRODUCTION_NAME_ATTACKS) {
      const verdict = judgeTokenIdentity({
        symbol,
        name,
        scamProbability: scoreAtCreation(symbol, name),
      });
      expect(verdict.nameAttack, `${symbol} ${name}`).toBe(true);
    }
  });

  /**
   * The conjunction is the mechanism, and this proves it is a conjunction
   * rather than the score doing the work alone. These legitimate tokens
   * score at or above the threshold — indistinguishable from the scams
   * above — and are admitted purely because they carry no host.
   *
   * If someone later "simplifies" the rule to refuse on an elevated score,
   * this test fails and Uniswap and SushiSwap stop importing.
   *
   * **Three fixtures left this list in SC-275**, and why is worth keeping.
   * `Curve DAO Token`, `Lido DAO Token` and `1inch Network` used to score
   * 0.80 here — but only because `URL_PATTERN` read the space before
   * "Token" and "Network" as a domain. They now score 0.00. The test was
   * encoding a false positive as expected behaviour, which is how it
   * survived: it asserted the number was high without asking why.
   *
   * The two that remain score 0.40 for a real reason — the substring
   * "swap" is in `SUSPICIOUS_WORDS` — so the conjunction still has
   * something to prove.
   */
  test('legitimate tokens scoring as high as the scams are admitted, having no host', () => {
    for (const [symbol, name] of [
      ['UNI', 'Uniswap'],
      ['SUSHI', 'SushiSwap'],
    ] as ReadonlyArray<readonly [string, string]>) {
      const score = scoreAtCreation(symbol, name);
      expect(score, `${name} should score high`).toBeGreaterThanOrEqual(0.35);
      expect(
        judgeTokenIdentity({ symbol, name, scamProbability: score }).nameAttack,
        `${symbol} ${name}`
      ).toBe(false);
    }
  });

  /**
   * The names those three fixtures used to be (SC-275). A legitimate token
   * whose name merely contains the word "Token" or "Network" must score
   * nothing at all — it was 0.80, over the 0.35 gate, so excluded from
   * every portfolio total and the historical chart.
   */
  test('a name containing "Token" or "Network" is not a domain', () => {
    for (const [symbol, name] of [
      ['CRV', 'Curve DAO Token'],
      ['LDO', 'Lido DAO Token'],
      ['1INCH', '1inch Network'],
    ] as ReadonlyArray<readonly [string, string]>) {
      expect(scoreAtCreation(symbol, name), `${symbol} ${name}`).toBe(0);
    }
  });

  /**
   * The other side of the conjunction: a host-shaped name that is NOT
   * otherwise suspicious. `yearn.finance` is a real project and scores
   * 0.30, under the threshold, so the host alone does not refuse it.
   *
   * It is close to the line, and deliberately recorded as such: it clears
   * by 0.05, and it clears partly because `.finance` is not in either TLD
   * list. Widening those lists moves this case, so it is asserted rather
   * than assumed.
   */
  test('a host-shaped name that is not otherwise suspicious is admitted', () => {
    const score = scoreAtCreation('YFI', 'yearn.finance');
    expect(score).toBeLessThan(0.35);
    expect(
      judgeTokenIdentity({ symbol: 'YFI', name: 'yearn.finance', scamProbability: score })
        .nameAttack
    ).toBe(false);
  });

  /**
   * Omitting the score means "no evidence", and a bare host alone must not
   * refuse. This is the safe direction — the failure it avoids (blocking a
   * real import) is worse than the one it allows — and it keeps every
   * existing caller that has no score to give from silently regressing
   * to SC-220's behaviour.
   */
  test('without a score, a bare host is not enough to refuse', () => {
    expect(judgeTokenIdentity({ symbol: 'HEX', name: '#HEXPool.net' }).nameAttack).toBe(false);
    expect(judgeTokenIdentity({ symbol: 'BKNG', name: 'BOOKING.COM' }).nameAttack).toBe(false);
  });

  test('the ingest gate still refuses a name that sends you somewhere', () => {
    for (const [symbol, name] of [
      ['VOUCHER', '✅ SWAP YOUR VOUCHER ON T.LY/SHIBASWAP'],
      ['ETHER', 'SWAP YOUR VOUCHER ON WR.DO/S/ETHER'],
    ] as ReadonlyArray<readonly [string, string]>) {
      const verdict = judgeTokenIdentity({ symbol, name });
      expect(verdict.nameAttack, `${symbol} ${name}`).toBe(true);
      expect(verdict.quarantine, `${symbol} ${name}`).toBe(true);
    }
  });
});

/**
 * SC-276. The decode runs BEFORE the judge, and this is why that ordering
 * is load-bearing rather than incidental.
 *
 * `decodeProviderText` was written for a display bug — mgrin's phone showed
 * `VANGUARD S&amp;P 500 ETF`. But the same characters reach the name-attack
 * detector, and a host is a host only if the dot survives. Measured here:
 * `yield-farming&#46;io` is ADMITTED as it arrives and REFUSED once decoded.
 * So the position of the decode decides whether a single entity-encoded dot
 * is an evasion, and putting it after the judge would have opened one.
 *
 * It is not a general anti-evasion mechanism and must not be mistaken for
 * one: the named-entity table is deliberately six entries, so `&period;`
 * passed straight through it. That hole is now closed in the DETECTOR
 * rather than in the decoder (SC-281, below) — the ordering asserted here
 * still matters, but it is no longer the only thing standing between an
 * encoded dot and an admitted scam row.
 */
describe('a provider-encoded name is judged as the text it will become (SC-276)', () => {
  const detector = new ScamTokenDetectionService();
  const judgeAs = (symbol: string, name: string) =>
    judgeTokenIdentity({
      symbol,
      name,
      scamProbability: detector.calculateScamProbability(symbol, name, new Date('2020-01-01')),
    });

  /**
   * This test used to assert that the encoded form was ADMITTED and only the
   * decoded form refused — which made the decode's position the only thing
   * standing between an encoded dot and a scam row. SC-281 deliberately ended
   * that: the detector normalises its own input, so both forms now reach the
   * same verdict and the ordering is no longer load-bearing for SAFETY.
   *
   * It is still load-bearing for HONESTY, which is what the remaining tests in
   * this block cover: the row we judge must be the row we store, or the verdict
   * stops describing what the user sees.
   */
  test('the verdict no longer depends on whether the decode ran first', () => {
    const encoded = 'yield-farming&#46;io';
    expect(judgeAs('YF', encoded).nameAttack).toBe(true);
    expect(judgeAs('YF', decodeProviderText(encoded)).nameAttack).toBe(true);
  });

  /**
   * The limit this test used to record. `&period;` is still outside the
   * storage table — that has not changed and must not — but the detector now
   * normalises its own input, so the row is refused anyway. Both halves are
   * asserted together: if someone "fixes" this by growing the storage table,
   * the first expectation fails and says so.
   */
  test('a named entity outside the six-entry table no longer evades', () => {
    const encoded = '#HEXPool&period;net';
    expect(decodeProviderText(encoded)).toBe(encoded);
    expect(judgeAs('HEX', encoded).nameAttack).toBe(true);
  });

  test('decoding does not invent an attack out of an ordinary instrument name', () => {
    // The two rows that started the ticket. `&` is not a host, and a
    // decoder that made these refuse would block two real ETFs.
    for (const name of ['VANGUARD S&amp;P 500 ETF', 'ISHARES CORE S&amp;P US TOTAL MA']) {
      expect(judgeAs('VOO', decodeProviderText(name)).nameAttack).toBe(false);
    }
    expect(judgeAs('MCO', decodeProviderText('MOODY&#39;S CORP')).nameAttack).toBe(false);
  });

  test('a homoglyph carrying an encoded name is still quarantined, not refused', () => {
    // The composition SC-207 changed underneath this: a lookalike is
    // CREATED with `lookalikeOf` set so the balance stays visible, and
    // only a name attack refuses outright. Decoding the name must not
    // push it over into refusal.
    const verdict = judgeAs('UЅDС', decodeProviderText('Circle S&amp;P Reserve'));
    expect(verdict.lookalikeOf).toBe('USDC');
    expect(verdict.nameAttack).toBe(false);
  });
});

/**
 * SC-281. The detector normalises the string it judges, independently of what
 * the storage layer decides to store.
 *
 * The evasion, measured on the real `ScamTokenDetectionService` before the fix
 * — score at creation, then the ingest gate's own verdict:
 *
 *     yield-farming.io           0.50  bareHost true   refused
 *     yield-farming&#46;io       0.50  bareHost true   refused   (SC-276, by side effect)
 *     yield-farming&period;io    0.00  bareHost false  ADMITTED
 *     #HEXPool&period;net        0.50  bareHost false  ADMITTED
 *     T&period;LY&sol;SHIBASWAP  0.40  attack   false  ADMITTED
 *
 * Note the score column: `yield-farming&period;io` scored **0.00**, not 0.50.
 * Fixing only `nameHasBareHost` would not have closed it, because the bare-host
 * rule refuses only in conjunction with an elevated score and there was none.
 * The normalisation has to reach `calculateScamProbability` too, which is why
 * `SCAM_SCORE_VERSION` moves in the same commit.
 */
describe('an encoded or confusable separator does not evade the detector (SC-281)', () => {
  const detector = new ScamTokenDetectionService();
  const judgeAs = (symbol: string, name: string) =>
    judgeTokenIdentity({
      symbol,
      name,
      scamProbability: detector.calculateScamProbability(symbol, name, new Date('2020-01-01')),
    });

  /**
   * The nine production name-attacks from SC-224, re-encoded. Each is the
   * string that was found in the database with its separators hidden — the
   * cheapest possible edit an attacker makes once we start refusing the
   * original.
   */
  const ENCODED_PRODUCTION_ATTACKS: ReadonlyArray<readonly [string, string]> = [
    ['VOUCHER', '✅ SWAP YOUR VOUCHER ON T&period;LY&sol;SHIBASWAP'],
    ['ETHER', 'SWAP YOUR VOUCHER ON WR&period;DO&sol;S&sol;ETHER'],
    ['HEX', '#HEXPool&period;net'],
    ['YF', 'yield-farming&period;io'],
    ['MW', '@ MetaWin&period;to'],
    ['DRAF', 'Draf&period;io'],
    ['EF2', 'EthFork2&period;com'],
    ['AIN', 'Aintiution&period;io'],
    ['SHORT', 'bit&period;ly&sol;free-tokens'],
  ];

  test('every production attack is still refused with its dots entity-encoded', () => {
    for (const [symbol, name] of ENCODED_PRODUCTION_ATTACKS) {
      expect(judgeAs(symbol, name).nameAttack, `${symbol} ${name}`).toBe(true);
    }
  });

  test('a doubly-encoded dot is refused, because decoding runs to a fixed point', () => {
    expect(judgeAs('YF', 'yield-farming&amp;period;io').nameAttack).toBe(true);
  });

  /**
   * THE CASES THAT ISOLATE `nameIsAttack`, and they exist because the first
   * negative control for this change PASSED GREEN.
   *
   * Reverting `nameIsAttack` to judge the raw string broke nothing, because
   * every encoded fixture above is also caught by the bare-host rule or by the
   * imperative — the same "caught by luck rather than by design" that this file
   * already records twice (`.ly` in SC-220, "Network" in SC-275).
   *
   * These five isolate it. Each is a KNOWN SHORTENER whose TLD is deliberately
   * absent from `BARE_HOST`'s list — `gl`, `gy`, `id`, `co`, `at` — so
   * `nameHasBareHost` is false, and each scores **0.00**, so the conjunction
   * has nothing to work with. `nameIsAttack` is the only rule that can refuse
   * them, and only if it normalises first.
   */
  const SHORTENER_ONLY_ENCODED: readonly string[] = [
    'goo&period;gl&sol;x',
    'rb&period;gy&sol;x',
    's&period;id&sol;x',
    't&period;co&sol;x',
    'shorturl&period;at&sol;x',
  ];

  test('an encoded shortener is refused by the name rule alone', () => {
    for (const name of SHORTENER_ONLY_ENCODED) {
      // The isolation is the point of the fixture, so it is asserted rather
      // than assumed: if a future TLD-list edit gives these a bare host or a
      // score, this test silently stops testing `nameIsAttack`.
      expect(detector.calculateScamProbability('X', name, new Date('2020-01-01')), name).toBe(0);
      expect(nameHasBareHost(name), name).toBe(false);

      expect(judgeAs('X', name).nameAttack, name).toBe(true);
    }
  });

  /**
   * The second channel. A Lisu `ꓸ` and a fullwidth `．` both draw a dot, and
   * the confusable fold that already powers the lookalike-symbol rule closes
   * them without a single new table entry.
   */
  test('a confusable dot is a dot', () => {
    expect(judgeAs('DRAF', 'Drafꓸio').nameAttack).toBe(true);
    expect(judgeAs('DRAF', 'Draf．io').nameAttack).toBe(true);
  });

  /**
   * THE REGRESSION THIS FIX COULD CAUSE, asserted so it cannot ship quietly.
   *
   * Normalisation must reach the CONTENT rules and never the CHARACTER-CLASS
   * ones. `UЅDС` normalises to `USDC` — so a `judgeSymbol` or homoglyph check
   * fed the normalised string reports a clean ASCII ticker and the 0.70 signal
   * disappears, taking `lookalikeOf` with it. The tempting "just normalise
   * everything, consistently" refactor is exactly this bug.
   */
  test('normalisation does NOT reach the symbol rules, which need the raw characters', () => {
    for (const { symbol, presentsAs } of PRODUCTION_LOOKALIKES) {
      const verdict = judgeSymbol(symbol);
      expect(verdict.lookalike, symbol).toBe(true);
      expect(verdict.lookalikeOf, symbol).toBe(presentsAs);
      expect(
        detector.calculateScamProbability(symbol, 'USD Coin', new Date('2020-01-01')),
        symbol
      ).toBeGreaterThanOrEqual(0.7);
    }
  });

  /**
   * SC-220's population, run back through the widened detector. Normalising
   * cannot be allowed to manufacture the false positive that blocked six real
   * equity imports — and it does not, because normalisation is the identity
   * function on plain ASCII.
   */
  test('the six legal names that SC-220 broke on are untouched by normalisation', () => {
    for (const name of LEGAL_NAMES_WITH_A_DOMAIN) {
      expect(normalizeForDetection(name), name).toBe(name);
      expect(nameIsAttack(name), name).toBe(false);
    }
  });

  test('normalisation leaves ordinary instrument names exactly as they are', () => {
    for (const name of [
      'United States Covert Operations Network',
      'Curve DAO Token',
      '1inch Network',
      'yearn.finance',
      'VANGUARD S&P 500 ETF',
      'AT&T INC',
      'Wrapped Ether',
    ]) {
      expect(normalizeForDetection(name), name).toBe(name);
    }
  });

  /**
   * The scores that move, and the ones that must not. Only a name carrying an
   * entity or a confusable may change — everything else recomputes to what it
   * already held, which is what makes the `SCAM_SCORE_VERSION` bump a restamp
   * rather than a re-verdict for most of the corpus.
   */
  test('the version bump moves only encoded names, not plain ones', () => {
    const score = (symbol: string, name: string) =>
      detector.calculateScamProbability(symbol, name, new Date('2020-01-01'));

    expect(score('YF', 'yield-farming&period;io')).toBe(0.5);
    expect(score('DRAF', 'Drafꓸio')).toBe(0.5);

    expect(score('CRV', 'Curve DAO Token')).toBe(0);
    expect(score('1INCH', '1inch Network')).toBe(0);
    expect(score('USCON', 'United States Covert Operations Network')).toBe(0);
    // 0, not the 0.30 an older comment in this file claims: `.finance` is in
    // neither TLD list, and SC-275 removed the separator-less guess that used
    // to score it. Measured, not inherited.
    expect(score('YFI', 'yearn.finance')).toBe(0);
    expect(score('UNI', 'Uniswap')).toBe(0.4);
  });
});
