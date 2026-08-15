import { describe, expect, test } from 'bun:test';
import { describeQueryError, type ErrorCopy } from '@scani/ui/v3/lib/errors';

/**
 * §2.5's voice rules, asserted rather than reviewed.
 *
 * A style rule that lives only in a document gets broken by the third person
 * to add an error state, so the rules are checked across *every* branch this
 * module can produce — which is what makes adding a fifth branch a thing the
 * suite has an opinion about.
 */

const CASES: { name: string; error: unknown }[] = [
  { name: 'network failure', error: { message: 'Failed to fetch' } },
  { name: 'Safari network failure', error: { message: 'Load failed' } },
  { name: 'unauthorised', error: { data: { httpStatus: 401 } } },
  { name: 'forbidden', error: { data: { httpStatus: 403 } } },
  { name: 'timeout', error: { data: { httpStatus: 504 } } },
  { name: 'rate limited', error: { data: { httpStatus: 429 } } },
  { name: 'server error', error: { data: { httpStatus: 500 } } },
  { name: 'nothing recognisable', error: new Error('boom') },
  { name: 'not an object at all', error: 'boom' },
  { name: 'null', error: null },
];

const APOLOGIES = ['sorry', 'apolog', 'unfortunately', 'oops', 'uh oh', 'whoops'];
const VAGUENESS = ['something went wrong', 'an error occurred', 'unknown error', 'try later'];

function every(): ErrorCopy[] {
  return CASES.map((entry) => describeQueryError(entry.error, 'your holdings'));
}

describe('describeQueryError — the §2.5 voice rules', () => {
  test('never apologises', () => {
    for (const copy of every()) {
      const text = `${copy.title} ${copy.detail}`.toLowerCase();
      for (const word of APOLOGIES) expect(text).not.toInclude(word);
    }
  });

  test('never says only that the app noticed', () => {
    for (const copy of every()) {
      const text = `${copy.title} ${copy.detail}`.toLowerCase();
      for (const phrase of VAGUENESS) expect(text).not.toInclude(phrase);
    }
  });

  /** Two sentences, both of them claims: what happened, and what the reader
   *  should do or can rely on. A detail that is only a restatement of the
   *  title is a paragraph doing one sentence's work. */
  test('every branch says what happened and then what follows from it', () => {
    for (const copy of every()) {
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.detail).toMatch(/[.!]$/);
      expect(copy.detail).not.toBe(copy.title);
      expect(copy.retryLabel.length).toBeGreaterThan(0);
    }
  });

  /** "Couldn't reach Kraken. Retry" beats "Something went wrong" because it
   *  names the thing. The subject is the caller's and has to survive. */
  test('the caller’s subject reaches the copy', () => {
    const copy = describeQueryError({ data: { httpStatus: 500 } }, 'upcoming payments');
    expect(`${copy.title} ${copy.detail}`).toInclude('upcoming payments');
  });
});

describe('describeQueryError — the branches say different things', () => {
  test('a request that never left the device blames the connection', () => {
    const copy = describeQueryError({ message: 'Failed to fetch' }, 'your holdings');
    expect(copy.title).toBe("Couldn't reach the server");
    expect(copy.detail).toInclude('connection');
  });

  test('an expired session says so instead of blaming the server', () => {
    expect(describeQueryError({ data: { httpStatus: 401 } }, 'x').title).toBe('Your session ended');
  });

  test('rate limiting asks for a wait, since an instant retry cannot work', () => {
    const copy = describeQueryError({ data: { httpStatus: 429 } }, 'x');
    expect(copy.detail).toInclude('Wait');
  });

  /** The only reassurance a finance app owes on a *read* failure: nothing was
   *  written. It is on every branch that could look like data loss. */
  test('a failed read states that the data is untouched', () => {
    for (const status of [500, 504]) {
      expect(describeQueryError({ data: { httpStatus: status } }, 'x').detail).toInclude(
        'untouched'
      );
    }
  });

  /** A status only counts when it is a number — a stray string would otherwise
   *  fall through the `===` comparisons into the generic branch silently. */
  test('a non-numeric status is not read as one', () => {
    const copy = describeQueryError({ data: { httpStatus: '401' } }, 'your holdings');
    expect(copy.title).toBe("Couldn't load your holdings");
  });
});

describe('describeQueryError — a rejection names its reason (SC-140)', () => {
  /** What the API actually throws when Kraken refuses the keys: a 400 whose
   *  message is the provider's own words, rethrown deliberately so the UI can
   *  say which field is wrong. It reached the browser and was discarded. */
  const krakenRefusal = {
    data: { httpStatus: 400 },
    message: 'Kraken rejected request: EAPI:Invalid key',
  };

  test('the provider’s reason is what the reader is shown', () => {
    const copy = describeQueryError(krakenRefusal, 'Kraken', 'connect');
    expect(copy.detail).toInclude('EAPI:Invalid key');
  });

  /** The old sentence said "load" for an action that was a connect, and blamed
   *  "the server" — so the rational next step was to wait, not to re-check the
   *  key the reader had just typed. */
  test('the title names the action the reader took, not a read', () => {
    const copy = describeQueryError(krakenRefusal, 'Kraken', 'connect');
    expect(copy.title).toBe("Couldn't connect Kraken");
    expect(copy.detail).not.toInclude('The server returned an error');
  });

  test('a rejected write still states that nothing was written', () => {
    expect(describeQueryError(krakenRefusal, 'Kraken', 'connect').detail).toInclude('untouched');
  });

  test('the verb defaults to load, so every existing caller is unchanged', () => {
    expect(describeQueryError({ data: { httpStatus: 500 } }, 'your holdings').title).toBe(
      "Couldn't load your holdings"
    );
  });

  test('422 is the same case as 400', () => {
    const copy = describeQueryError(
      { data: { httpStatus: 422 }, message: 'That account is already connected' },
      'Kraken',
      'connect'
    );
    expect(copy.detail).toInclude('already connected');
  });

  /** These are the messages that must NOT reach a screen. A zod failure is
   *  serialised into the same status as a real refusal, and a `TRPCError`
   *  thrown with no message carries its own code as one. */
  test.each([
    ['a zod issue array', '[{"code":"too_small","path":["apiKey"]}]'],
    ['an object', '{"error":"nope"}'],
    ['a bare tRPC code', 'BAD_REQUEST'],
    ['a stack trace', 'Error: nope\n    at foo (bar.ts:1:1)'],
    ['a wall of text', 'x'.repeat(201)],
    ['nothing at all', ''],
  ])('%s falls back to the generic sentence', (_name, message) => {
    const copy = describeQueryError({ data: { httpStatus: 400 }, message }, 'Kraken', 'connect');
    expect(copy.detail).toBe('The server returned an error. Your data is untouched.');
  });

  /** The detail is one sentence followed by the reassurance, so a provider
   *  that punctuates its own message must not produce "key.. Your data". */
  test('a reason that already ends in a full stop is not doubled', () => {
    const copy = describeQueryError(
      { data: { httpStatus: 400 }, message: 'Those keys need the Query Funds permission.' },
      'Kraken',
      'connect'
    );
    expect(copy.detail).toBe('Those keys need the Query Funds permission. Your data is untouched.');
  });
});
