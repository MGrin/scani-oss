import { describe, expect, it } from 'bun:test';
import Decimal from 'decimal.js';
import {
  findSupersededEdits,
  type ImportedCandidate,
  type ManualEditCandidate,
} from '../../../src/lib/transactions/manual-edit-supersession';

const at = (iso: string) => new Date(iso);
const edit = (over: Partial<ManualEditCandidate> = {}): ManualEditCandidate => ({
  flowId: 'edit-1',
  rowIds: ['edit-1'],
  amount: new Decimal('5600.75'),
  occurredAt: at('2026-08-27T00:00:00Z'),
  editedAt: at('2026-08-27T09:00:00Z'),
  answer: null,
  ...over,
});
const row = (id: string, qty: string, iso: string, answer: ImportedCandidate['answer'] = null) => ({
  id,
  quantity: new Decimal(qty),
  occurredAt: at(iso),
  answer,
});

describe('findSupersededEdits (SC-1468)', () => {
  it('matches an edit to the imported rows that add up to it, fee included', () => {
    const verdicts = findSupersededEdits(
      [edit()],
      [row('dep', '5617.60', '2026-08-28T03:00:00Z'), row('fee', '-16.85', '2026-08-28T03:00:00Z')]
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.status).toBe('supersede');
    expect([...(verdicts[0]?.importedIds ?? [])].sort()).toEqual(['dep', 'fee']);
  });

  it('supersedes an answered edit when the imported row carries the same answer', () => {
    const answer = { kind: 'split', destination: 'wise-savings:5000' };
    const verdicts = findSupersededEdits(
      [edit({ amount: new Decimal('-5000'), answer })],
      [row('out', '-5000', '2026-08-27T12:00:00Z', answer)]
    );
    expect(verdicts[0]?.status).toBe('supersede');
  });

  it('keeps an edit whose answer differs from the imported answer, so the owner sees it', () => {
    const verdicts = findSupersededEdits(
      [
        edit({
          amount: new Decimal('-5500'),
          answer: { kind: 'split', destination: 'wise:2000|left:3500' },
        }),
      ],
      [
        row('out', '-5500', '2026-08-27T12:00:00Z', {
          kind: 'split',
          destination: 'wise:2000|revolut:2000|left:1500',
        }),
      ]
    );
    expect(verdicts[0]?.status).toBe('answer-differs');
  });

  it('keeps an answered edit whose imported row is unanswered', () => {
    const verdicts = findSupersededEdits(
      [edit({ amount: new Decimal('-1000'), answer: { kind: 'left_control', destination: null } })],
      [row('out', '-1000', '2026-08-27T12:00:00Z')]
    );
    expect(verdicts[0]?.status).toBe('answer-differs');
  });

  it('matches nothing when two different subsets both add up to the edit', () => {
    const verdicts = findSupersededEdits(
      [edit({ amount: new Decimal('100') })],
      [row('a', '100', '2026-08-27T01:00:00Z'), row('b', '100', '2026-08-27T02:00:00Z')]
    );
    expect(verdicts).toHaveLength(0);
  });

  it('control: rows outside the window are not evidence', () => {
    const verdicts = findSupersededEdits(
      [edit()],
      [row('dep', '5617.60', '2026-09-05T00:00:00Z'), row('fee', '-16.85', '2026-09-05T00:00:00Z')]
    );
    expect(verdicts).toHaveLength(0);
  });

  it('never hands one imported row to two edits', () => {
    const verdicts = findSupersededEdits(
      [
        edit({ flowId: 'e1', rowIds: ['e1'], amount: new Decimal('50') }),
        edit({
          flowId: 'e2',
          rowIds: ['e2'],
          amount: new Decimal('50'),
          occurredAt: at('2026-08-27T01:00:00Z'),
        }),
      ],
      [row('only', '50', '2026-08-27T12:00:00Z')]
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.edit.flowId).toBe('e1');
  });
});
