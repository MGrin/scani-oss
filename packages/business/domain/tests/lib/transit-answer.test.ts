import { describe, expect, test } from 'bun:test';
import { Decimal, type TransferReviewSplitPortion } from '@scani/shared';
import { replaceTravelledPart } from '../../src/lib/transit-answer';

const ACCOUNT_A = '00000000-0000-4000-8000-00000000000a';
const ACCOUNT_B = '00000000-0000-4000-8000-00000000000b';
const HOLDING_A = '00000000-0000-4000-8000-0000000000a1';
const HOLDING_B = '00000000-0000-4000-8000-0000000000b1';

const arrivedWithFee =
  (arrived: string) =>
  (travelled: TransferReviewSplitPortion): TransferReviewSplitPortion[] => [
    { ...travelled, quantity: arrived },
    {
      decision: 'fee',
      quantity: new Decimal(travelled.quantity).minus(arrived).toString(),
    },
  ];

describe('replaceTravelledPart — the part that travelled to this destination (SC-1675, SC-1665)', () => {
  test('two equal internal parts: only the one aimed at this holding is replaced', () => {
    const parts = replaceTravelledPart(
      {
        review: 'split',
        quantity: '-200',
        split: [
          {
            decision: 'internal',
            quantity: '100',
            destination: { accountId: ACCOUNT_A, holdingId: HOLDING_A },
          },
          {
            decision: 'internal',
            quantity: '100',
            destination: { accountId: ACCOUNT_B, holdingId: HOLDING_B },
          },
        ],
      },
      new Decimal('100'),
      { accountId: ACCOUNT_B, holdingId: HOLDING_B },
      arrivedWithFee('95')
    );

    expect(parts).toEqual([
      {
        decision: 'internal',
        quantity: '100',
        destination: { accountId: ACCOUNT_A, holdingId: HOLDING_A },
      },
      {
        decision: 'internal',
        quantity: '95',
        destination: { accountId: ACCOUNT_B, holdingId: HOLDING_B },
      },
      { decision: 'fee', quantity: '5' },
    ]);
  });

  test('a part that opened a holding in an account matches by that account', () => {
    const parts = replaceTravelledPart(
      {
        review: 'split',
        quantity: '-150',
        split: [
          { decision: 'fee', quantity: '50' },
          {
            decision: 'internal',
            quantity: '100',
            destination: { accountId: ACCOUNT_B, holdingId: null },
          },
        ],
      },
      new Decimal('100'),
      { accountId: ACCOUNT_B, holdingId: HOLDING_B },
      arrivedWithFee('90')
    );

    expect(parts).toEqual([
      { decision: 'fee', quantity: '60' },
      {
        decision: 'internal',
        quantity: '90',
        destination: { accountId: ACCOUNT_B, holdingId: null },
      },
    ]);
  });

  test('an internal part of the same size aimed elsewhere is never taken', () => {
    const parts = replaceTravelledPart(
      {
        review: 'split',
        quantity: '-150',
        split: [
          { decision: 'fee', quantity: '50' },
          {
            decision: 'internal',
            quantity: '100',
            destination: { accountId: ACCOUNT_A, holdingId: HOLDING_A },
          },
        ],
      },
      new Decimal('100'),
      { accountId: ACCOUNT_B, holdingId: HOLDING_B },
      arrivedWithFee('95')
    );

    expect(parts).toBeNull();
  });

  test('CONTROL: a whole internal answer keeps its destination on the arrived part', () => {
    const parts = replaceTravelledPart(
      { review: 'internal', quantity: '-100', split: null },
      new Decimal('100'),
      { accountId: ACCOUNT_B, holdingId: HOLDING_B },
      arrivedWithFee('95')
    );

    expect(parts).toEqual([
      {
        decision: 'internal',
        quantity: '95',
        destination: { accountId: ACCOUNT_B, holdingId: HOLDING_B },
      },
      { decision: 'fee', quantity: '5' },
    ]);
  });
});
