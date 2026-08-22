/**
 * SC-544 — `tokens.decimals` may only carry a number an authority produced.
 *
 * The column was `real NOT NULL DEFAULT 2` and 20 of 251 production rows
 * carried a value no source had ever supplied: 14 equities at 18 from one IBKR
 * import, and 6 chainless crypto rows at 18 from `typeCode === 'crypto' ? 18 :
 * 2`. Neither writer was lying — neither had an answer, and the schema gave
 * them no way to say so.
 *
 * These tests assert the two structural properties that replace that, and they
 * are BEHAVIOURAL rather than a grep for the deleted expressions on purpose. An
 * absence guard — "no file contains `? 18 : 2`" — passes honestly the day it is
 * written and goes vacuous later, when the string disappears for an unrelated
 * reason, and from then on it can never fire again. What cannot go vacuous is
 * asking the resolver what it does with nothing.
 */
import { describe, expect, it } from 'bun:test';
import {
  attributeDecimals,
  PROTOCOL_NATIVE_DECIMALS,
  protocolNativeDecimals,
  resolveDecimals,
} from '../src/schema';

describe('attributeDecimals', () => {
  it('pairs a value with the authority that produced it', () => {
    expect(attributeDecimals(6, 'chain')).toEqual({ decimals: 6, decimalsSource: 'chain' });
  });

  it('drops the authority when nobody actually answered', () => {
    // The whole defect in one line: a writer with no answer used to supply a
    // number anyway. `undefined` in must never become a number out.
    expect(attributeDecimals(undefined, 'chain')).toEqual({
      decimals: null,
      decimalsSource: null,
    });
    expect(attributeDecimals(null, 'iso4217')).toEqual({ decimals: null, decimalsSource: null });
  });

  it('refuses an answer that is not a count of digits', () => {
    // `real` let 2.5 into this column for its whole life. A non-integer or a
    // negative is not a scale, and silently rounding one would be a third
    // writer inventing a value.
    expect(attributeDecimals(2.5, 'chain').decimals).toBeNull();
    expect(attributeDecimals(-1, 'chain').decimals).toBeNull();
    expect(attributeDecimals(Number.NaN, 'chain').decimals).toBeNull();
  });

  it('never returns one half of the pair', () => {
    // The DB says the same thing in `tokens_decimals_source_needs_value_chk`.
    // Both, because a constraint cannot stop a caller setting the two columns
    // separately and this function is what makes that impossible to express.
    for (const input of [8, 0, undefined, null, 1.5, -2, Number.NaN]) {
      const { decimals, decimalsSource } = attributeDecimals(input, 'protocol');
      expect(decimals === null).toBe(decimalsSource === null);
    }
  });
});

describe('PROTOCOL_NATIVE_DECIMALS', () => {
  /**
   * The condition this table was accepted on: only what can be CITED goes in.
   *
   * It is a table of constants an agent cannot verify by calling anything, so
   * the citation is the only thing standing between it and a guess one
   * indirection further from the reader than `? 18 : 2` was. An entry added by
   * inference — "BABY is probably 6, like other Cosmos assets" — is the exact
   * failure this whole ticket is about, and it would look completely at home
   * beside the six honest rows.
   *
   * NOT a length check on a string that could be anything: the citation has to
   * name a command AND the value it returned, so the next reader can re-run it
   * rather than trust the person who typed it.
   */
  it('cites a re-runnable measurement for every entry', () => {
    for (const [id, entry] of PROTOCOL_NATIVE_DECIMALS) {
      expect(id).not.toBe('');
      expect(entry.unit.length).toBeGreaterThan(0);
      expect(entry.citation).toMatch(/https?:\/\//);
      // The measured value has to APPEAR in the citation, so a citation cannot
      // be pasted from a neighbouring entry and left to disagree with the
      // decimals beside it.
      expect(entry.citation).toContain(String(entry.decimals));
      expect(entry.citation).toMatch(/20\d\d-\d\d-\d\d/);
    }
  });

  it('is keyed on the CoinGecko id, never the symbol', () => {
    // Production carries `SOL03` and `BABY` as Kraken asset codes and seven
    // homoglyph impersonations of USDC/USDT. A symbol is not an identity, and a
    // table keyed on one would attribute Bitcoin's 8 to whatever called itself
    // BTC.
    for (const id of PROTOCOL_NATIVE_DECIMALS.keys()) {
      expect(id).toBe(id.toLowerCase());
    }
    // The lookup reads `coingecko.id` and nothing else, so a row carrying only
    // a ticker gets no constant however familiar the ticker looks.
    expect(protocolNativeDecimals({ symbol: 'BTC' })).toBeNull();
    expect(protocolNativeDecimals({ kraken: { asset: 'XXBT' } })).toBeNull();
  });

  it('answers nothing for a row with no CoinGecko id', () => {
    expect(protocolNativeDecimals({})).toBeNull();
    expect(protocolNativeDecimals({ kraken: { asset: 'BABY' } })).toBeNull();
    expect(protocolNativeDecimals(null)).toBeNull();
    // Control: a row that DOES carry one comes back, so the three nulls above
    // are the rule answering rather than the lookup being broken.
    expect(protocolNativeDecimals({ coingecko: { id: 'cardano' } })?.decimals).toBe(6);
  });
});

describe('resolveDecimals', () => {
  it('takes the caller answer over the table, even when they disagree', () => {
    /**
     * A future reader will see this and want to "fix" it — our own cited table
     * says Solana is 9, and here a caller passing 6 wins. Do not.
     *
     * The caller's number came from the ASSET'S OWN CHAIN: `decimals()` on the
     * authoritative contract, or the mint's `getTokenSupply`. This table exists
     * for assets that have no contract to ask. Letting it outrank a contract
     * would be SC-403's defect in a new place — a lookup keyed on a shared name
     * deciding something for a row that already has a stronger identity. The
     * six entries here are natives; a token that carries BOTH a chain answer
     * and a CoinGecko id of the same name is a wrapped or bridged asset whose
     * own contract is the truth.
     *
     * If this assertion ever has to change, the table is being asked to do a
     * job it was not accepted for, and the right move is to delete the entry.
     */
    expect(resolveDecimals(6, 'chain', { coingecko: { id: 'solana' } })).toEqual({
      decimals: 6,
      decimalsSource: 'chain',
    });
  });

  it('falls back to the protocol constant only when nobody answered', () => {
    expect(resolveDecimals(undefined, undefined, { coingecko: { id: 'polkadot' } })).toEqual({
      decimals: 10,
      decimalsSource: 'protocol',
    });
  });

  it('returns nothing rather than a default when no authority can answer', () => {
    // A Kraken-only row. This is the case that used to become 18, and it is
    // still the common case: NULL is the ordinary answer here, not an error.
    expect(resolveDecimals(undefined, undefined, { kraken: { asset: 'BABY' } })).toEqual({
      decimals: null,
      decimalsSource: null,
    });
  });

  it('keeps an explicit non-chain authority the caller named', () => {
    expect(resolveDecimals(4, 'user', {})).toEqual({ decimals: 4, decimalsSource: 'user' });
  });
});
