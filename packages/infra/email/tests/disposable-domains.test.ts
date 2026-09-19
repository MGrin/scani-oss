import { describe, expect, test } from 'bun:test';
import { emailDomain, isDisposableEmail } from '../src/disposable-domains';

describe('isDisposableEmail (SC-1260)', () => {
  test.each([
    'scani4zze0af5@uberip.com',
    'x@mail.tm',
    'X@MAILINATOR.COM',
    'x@eu.mailinator.com',
    '  x@yopmail.fr  ',
  ])('refuses %s', (address) => {
    expect(isDisposableEmail(address)).toBe(true);
  });

  test.each([
    'alice@gmail.com',
    'x@mail.tm.example.com',
    'x@notmailinator.com',
    'x@gmail.com.uberip.co',
    'no-at-sign',
    'trailing@',
  ])('keeps %s', (address) => {
    expect(isDisposableEmail(address)).toBe(false);
  });

  test('a long run of trailing dots is stripped in linear time', () => {
    expect(emailDomain(`x@mail.tm${'.'.repeat(50_000)}`)).toBe('mail.tm');
    expect(emailDomain(`x@mail.tm${' .'.repeat(50_000)}`)).toBe('mail.tm');
  });

  test('reads the domain after the last @', () => {
    expect(emailDomain('"a@b"@Example.COM')).toBe('example.com');
    expect(emailDomain('x@mailinator.com >')).toBe('mailinator.com');
    expect(emailDomain('x@mailinator.com .\t> ')).toBe('mailinator.com');
  });
});
