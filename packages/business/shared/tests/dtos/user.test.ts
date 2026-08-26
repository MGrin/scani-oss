import { describe, expect, test } from 'bun:test';
import { ObservedBurnAnswerDto, UpdateUserDto } from '../../src/dtos/user';

const VALID_UUID = '00000000-0000-4000-8000-000000000000';

describe('UpdateUserDto', () => {
  test('accepts an empty patch (all fields optional)', () => {
    expect(UpdateUserDto.safeParse({}).success).toBe(true);
  });

  test('accepts a name change only', () => {
    expect(UpdateUserDto.safeParse({ name: 'Alice' }).success).toBe(true);
  });

  test('accepts a baseCurrencyId change only', () => {
    expect(UpdateUserDto.safeParse({ baseCurrencyId: VALID_UUID }).success).toBe(true);
  });

  test('avatar accepts null (explicit clear)', () => {
    expect(UpdateUserDto.safeParse({ avatar: null }).success).toBe(true);
  });

  test('baseCurrencyId accepts null (explicit clear)', () => {
    expect(UpdateUserDto.safeParse({ baseCurrencyId: null }).success).toBe(true);
  });

  test('rejects empty name', () => {
    expect(UpdateUserDto.safeParse({ name: '' }).success).toBe(false);
  });

  test('rejects non-URL avatar', () => {
    expect(UpdateUserDto.safeParse({ avatar: 'not-a-url' }).success).toBe(false);
  });

  test('rejects non-uuid baseCurrencyId', () => {
    expect(UpdateUserDto.safeParse({ baseCurrencyId: 'not-a-uuid' }).success).toBe(false);
  });
});

const UUID = '11111111-2222-3333-4444-555555555555';

/**
 * SC-661. What the user may say about the MEASURED monthly drain.
 *
 * A discriminated union rather than a bag of optional fields, because the
 * database says the same thing and the two must not be able to disagree:
 * `users_observed_burn_one_answer` forbids an override and a confirmation
 * standing at once.
 */
describe('ObservedBurnAnswerDto', () => {
  test('the three intentions parse', () => {
    expect(
      ObservedBurnAnswerDto.safeParse({ kind: 'override', amount: '6300', currencyTokenId: UUID })
        .success
    ).toBe(true);
    expect(
      ObservedBurnAnswerDto.safeParse({ kind: 'confirm', value: '8100', currencyTokenId: UUID })
        .success
    ).toBe(true);
    expect(ObservedBurnAnswerDto.safeParse({ kind: 'clear' }).success).toBe(true);
  });

  /**
   * THE STRUCTURAL ONE. Overriding and confirming are contradictory answers to
   * one question, and a shape that could carry both would be this ticket's own
   * defect — two surfaces disagreeing — moved into one payload.
   */
  test('an override and a confirmation cannot be sent together', () => {
    expect(
      ObservedBurnAnswerDto.safeParse({
        kind: 'override',
        amount: '6300',
        value: '8100',
        currencyTokenId: UUID,
      }).success
      // THIS SPEAKS FOR THE DTO ALONE, NOT FOR THE ENDPOINT (SC-682).
      // Bare, the DTO strips: `override` has no `value` member and zod drops
      // unknown keys by default, so the parse succeeds. What is pinned here is
      // that no parse RESULT can carry both, asserted on the output below.
      //
      // The api wraps this same DTO in `strictInput`, and there the identical
      // payload is a 400 rather than a strip. Both layers are correct and they
      // are correct about different things: this one guarantees the shape the
      // service receives, the endpoint refuses the caller who sent nonsense.
      // Said explicitly because this comment described end-to-end behaviour
      // that changed underneath it while the assertion stayed true — a comment
      // going false with no test going red.
    ).toBe(true);
    const parsed = ObservedBurnAnswerDto.parse({
      kind: 'override',
      amount: '6300',
      value: '8100',
      currencyTokenId: UUID,
    });
    expect(parsed).toEqual({ kind: 'override', amount: '6300', currencyTokenId: UUID });
    expect('value' in parsed).toBe(false);
  });

  /**
   * Zero is refused rather than read as "nothing leaves my accounts". It makes
   * the runway infinite, which is the most flattering possible way to be wrong.
   * Withdrawing an answer is `clear`, and the test above is its control.
   */
  test('neither figure may be zero or negative', () => {
    expect(
      ObservedBurnAnswerDto.safeParse({ kind: 'override', amount: '0', currencyTokenId: UUID })
        .success
    ).toBe(false);
    expect(
      ObservedBurnAnswerDto.safeParse({ kind: 'confirm', value: '-1', currencyTokenId: UUID })
        .success
    ).toBe(false);
  });

  /**
   * A confirmation without its value is the shape SC-673 is about, one layer
   * up: a stamp read as though it carried content. It must not be expressible.
   */
  test('a confirmation must carry the figure it agreed with', () => {
    expect(
      ObservedBurnAnswerDto.safeParse({ kind: 'confirm', currencyTokenId: UUID }).success
    ).toBe(false);
    expect(ObservedBurnAnswerDto.safeParse({ kind: 'confirm', value: '8100' }).success).toBe(false);
  });

  test('an unknown intention is refused rather than treated as one of the three', () => {
    expect(ObservedBurnAnswerDto.safeParse({ kind: 'reset' }).success).toBe(false);
    expect(ObservedBurnAnswerDto.safeParse({}).success).toBe(false);
    expect(ObservedBurnAnswerDto.safeParse(null).success).toBe(false);
  });
});
