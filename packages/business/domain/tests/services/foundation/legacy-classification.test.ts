import { describe, expect, test } from 'bun:test';
import type { FeedInput, FeedInputWindow, Holding, HoldingTransaction } from '@scani/db/schema';
import { BALANCE_GAP_UNKNOWN } from '@scani/shared';
import type { Entry, Observation } from '../../../src/engine/types';
import {
  type ClassifiedHolding,
  classifyHoldingEvidence,
  type EvidenceObservation,
  type LegacyHoldingEvidence,
} from '../../../src/services/foundation/legacy-classification';
import { utc } from '../../engine/fixtures';

const USER = 'u1';
const ACCOUNT = 'a1';
const HOLDING = 'h1';
const CREATED = utc('2026-03-01');

function holding(fields: Partial<Holding> = {}): Holding {
  return {
    id: HOLDING,
    userId: USER,
    accountId: ACCOUNT,
    tokenId: 'tok',
    balance: '0',
    source: 'manual',
    arrival: 'unattributed',
    externalId: null,
    label: null,
    isHidden: false,
    hiddenBy: null,
    isActive: true,
    manualEditCause: null,
    absentFromStatements: null,
    kind: null,
    startsAt: null,
    valueBase: null,
    valuePricedAt: null,
    lastUpdated: CREATED,
    createdAt: CREATED,
    ...fields,
  };
}

/** As the loader reads it: `source_metadata` as its `origin`, `source` and `legacyAnchor` strings. */
function observation(
  id: string,
  observedAt: Date,
  balance: string,
  fields: Partial<EvidenceObservation> = {}
): EvidenceObservation {
  return {
    id,
    holdingId: HOLDING,
    balance,
    observedAt,
    source: 'sync-capture',
    metadataOrigin: 'updateHolding',
    metadataSource: null,
    metadataLegacyAnchor: null,
    gapReview: null,
    role: null,
    authority: null,
    inputId: null,
    cause: null,
    supersededAt: null,
    createdAt: observedAt,
    ...fields,
  };
}

/** A balance a person typed: `UpdateHoldingUseCase` stamps every edit `sync-capture`. */
const personValue = observation;

function providerSync(
  id: string,
  at: Date,
  balance: string,
  fields: Partial<EvidenceObservation> = {}
): EvidenceObservation {
  return observation(id, at, balance, {
    metadataOrigin: 'updateHoldingBalanceWithEvent',
    ...fields,
  });
}

function statementClose(
  id: string,
  at: Date,
  balance: string,
  createdAt: Date
): EvidenceObservation {
  return observation(id, at, balance, {
    source: 'statement-close',
    metadataOrigin: null,
    createdAt,
  });
}

/** `HoldingService.updateHoldingBalance`: stamped at the moment it was written. */
function balanceCopy(id: string, createdAt: Date, balance: string): EvidenceObservation {
  return observation(id, createdAt, balance, {
    metadataOrigin: 'updateHoldingBalance',
    createdAt,
  });
}

/** The copy an APY run writes since ruling R12: the balance copy, marked as that run's anchor. */
function apyCopy(id: string, createdAt: Date, balance: string): EvidenceObservation {
  return { ...balanceCopy(id, createdAt, balance), metadataLegacyAnchor: 'apy-payout' };
}

function transaction(
  id: string,
  occurredAt: Date,
  quantity: string,
  fields: Partial<HoldingTransaction> = {}
): HoldingTransaction {
  return {
    id,
    userId: USER,
    holdingId: HOLDING,
    tokenId: 'tok',
    kind: 'deposit',
    quantity,
    priceNative: null,
    priceNativeTokenId: null,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    occurredAt,
    externalId: id,
    swapGroupId: null,
    transferGroupId: null,
    settlesTransactionId: null,
    transferReview: null,
    transferReviewedAt: null,
    transferReviewSource: null,
    transferReviewRuleId: null,
    transferReviewSplit: null,
    source: 'user-entered',
    sourceMetadata: {},
    rawPayload: null,
    counterparty: null,
    description: null,
    ledgerKind: null,
    kindSubtype: null,
    groupId: null,
    feeOf: null,
    inputId: null,
    executionPrice: null,
    executionPriceTokenId: null,
    kindOrigin: null,
    decisionId: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
    ...fields,
  };
}

function input(id: string, source: string): FeedInput {
  return {
    id,
    userId: USER,
    accountId: ACCOUNT,
    source,
    credentialId: null,
    walletId: null,
    status: 'active',
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

function inputWindow(
  id: string,
  inputId: string,
  fromAt: Date | null,
  toAt: Date
): FeedInputWindow {
  return { id, inputId, fromAt, toAt, complete: true, fetchedAt: toAt, uploadRef: null };
}

function evidence(fields: Partial<LegacyHoldingEvidence> = {}): LegacyHoldingEvidence {
  return {
    holding: holding(),
    observations: [],
    transactions: [],
    inputs: [],
    windows: [],
    ...fields,
  };
}

function classify(fields: Partial<LegacyHoldingEvidence> = {}): ClassifiedHolding {
  return classifyHoldingEvidence(evidence(fields));
}

function observationById(c: ClassifiedHolding, id: string): Observation | undefined {
  return c.evidence.observations.find((o) => o.id === id);
}

function rolesOf(c: ClassifiedHolding): Array<[string, string]> {
  return c.evidence.observations.map((o) => [o.id, o.role]);
}

function causesOf(c: ClassifiedHolding): Array<[string, string | null]> {
  return c.evidence.observations.map((o) => [o.id, o.cause]);
}

/** Each label written where the column is NULL, as the backfill's COALESCE does. */
function coalesce<T extends { id: string }>(row: T, label: object | undefined): T {
  if (label === undefined) return row;
  const merged: Record<string, unknown> = { ...row };
  for (const [key, value] of Object.entries(label)) {
    if (merged[key] === null) merged[key] = value;
  }
  return merged as T;
}

function backfilled(raw: LegacyHoldingEvidence): LegacyHoldingEvidence {
  const { labels } = classifyHoldingEvidence(raw);
  const byId = <L extends { id: string }>(ls: L[]) => new Map(ls.map((l) => [l.id, l]));
  const observationLabels = byId(labels.observations);
  const entryLabels = byId(labels.entries);
  return {
    ...raw,
    holding: coalesce(raw.holding, labels.holding),
    observations: raw.observations.map((o) => coalesce(o, observationLabels.get(o.id))),
    transactions: raw.transactions.map((t) => coalesce(t, entryLabels.get(t.id))),
  };
}

const WALLET_INPUT = input('in-w', 'etherscan');
const STATEMENT_INPUT = input('in-st', 'statement');

describe('the holding', () => {
  test('K1–K4 decide the holding kind', () => {
    const k1 = classify({ holding: holding({ source: 'blockchain' }) });
    expect(k1.evidence.kind).toBe('feed');
    expect(k1.notes).toEqual({ 'kind:K1': 1 });

    expect(classify({ holding: holding({ source: 'import_kraken' }) }).notes).toEqual({
      'kind:K1': 1,
    });

    const k2 = classify({ holding: holding({ externalId: 'BTC' }) });
    expect(k2.evidence.kind).toBe('feed');
    expect(k2.notes).toEqual({ 'kind:K2': 1 });

    const k3 = classify({
      observations: [statementClose('c1', utc('2026-01-31'), '100', utc('2026-02-02'))],
    });
    expect(k3.evidence.kind).toBe('feed');
    expect(k3.notes['kind:K3']).toBe(1);

    const k4 = classify({
      transactions: [transaction('t1', utc('2026-01-05'), '10', { source: 'user-entered' })],
    });
    expect(k4.evidence.kind).toBe('snapshot');
    expect(k4.notes).toEqual({ 'kind:K4': 1 });
    expect(k4.labels.holding.kind).toBe('snapshot');
  });

  test('K3: a chain or statement ledger row is feed evidence, a screenshot is not', () => {
    const chain = classify({
      transactions: [transaction('t1', utc('2026-01-05'), '10', { source: 'etherscan' })],
    });
    expect([chain.evidence.kind, chain.notes['kind:K3']]).toEqual(['feed', 1]);

    const statement = classify({
      transactions: [transaction('t1', utc('2026-01-05'), '10', { source: 'statement-csv' })],
    });
    expect(statement.evidence.kind).toBe('feed');

    const screenshot = classify({
      transactions: [transaction('t1', utc('2026-01-05'), '10', { source: 'screenshot' })],
    });
    expect([screenshot.evidence.kind, screenshot.notes['kind:K4']]).toEqual(['snapshot', 1]);
  });

  test("K3: a source's own balance on the holding is feed evidence", () => {
    const c = classify({
      observations: [providerSync('k1', utc('2026-01-10'), '100')],
    });
    expect([c.evidence.kind, c.notes['kind:K3']]).toEqual(['feed', 1]);
    expect(rolesOf(c)).toEqual([['k1', 'checkpoint']]);

    const typed = classify({ observations: [personValue('p1', utc('2026-01-10'), '100')] });
    expect([typed.evidence.kind, typed.notes['kind:K4']]).toEqual(['snapshot', 1]);
  });

  test('a persisted kind moves only from snapshot to feed, and is not re-emitted', () => {
    const upgraded = classify({
      holding: holding({ kind: 'snapshot' }),
      observations: [statementClose('c1', utc('2026-01-31'), '100', utc('2026-02-02'))],
    });
    expect(upgraded.evidence.kind).toBe('feed');
    expect(upgraded.labels.holding.kind).toBeUndefined();

    const kept = classify({ holding: holding({ kind: 'feed' }) });
    expect(kept.evidence.kind).toBe('feed');
    expect(kept.labels.holding.kind).toBeUndefined();
  });

  test('starts_at is the earliest real evidence', () => {
    const c = classify({
      observations: [personValue('o1', utc('2026-02-01'), '100')],
      transactions: [
        transaction('t1', utc('2026-01-01'), '10'),
        transaction('t0', utc('2025-12-31'), '50', {
          kind: 'opening_balance',
          source: 'reconciliation-opening',
        }),
      ],
    });
    expect(c.evidence.startsAt).toEqual(utc('2026-01-01'));
    expect(c.labels.holding.startsAt).toEqual(utc('2026-01-01'));
  });

  test('starts_at is created_at when there is no evidence', () => {
    expect(classify().evidence.startsAt).toEqual(CREATED);
  });

  test('a persisted starts_at only moves earlier, and is not re-emitted', () => {
    const lowered = classify({
      holding: holding({ startsAt: utc('2026-02-15') }),
      transactions: [transaction('t1', utc('2026-01-01'), '10')],
    });
    expect(lowered.evidence.startsAt).toEqual(utc('2026-01-01'));
    expect(lowered.labels.holding.startsAt).toBeUndefined();

    const kept = classify({
      holding: holding({ startsAt: utc('2025-11-01') }),
      transactions: [transaction('t1', utc('2026-01-01'), '10')],
    });
    expect(kept.evidence.startsAt).toEqual(utc('2025-11-01'));
  });
});

describe('observations', () => {
  test('O1: a statement close is a statement checkpoint on the statement input', () => {
    const c = classify({
      holding: holding({ source: 'statement-import' }),
      observations: [statementClose('c1', utc('2026-01-31'), '100', utc('2026-02-02'))],
      inputs: [WALLET_INPUT, STATEMENT_INPUT],
    });
    expect(c.evidence.observations).toEqual([
      {
        id: 'c1',
        at: utc('2026-01-31'),
        amount: '100',
        role: 'checkpoint',
        authority: 'statement',
        cause: null,
        inputId: 'in-st',
        supersededAt: null,
        recordedAt: utc('2026-02-02'),
      },
    ]);
    expect(c.labels.observations).toEqual([
      { id: 'c1', role: 'checkpoint', authority: 'statement', inputId: 'in-st' },
    ]);
    expect(c.notes['obs:O1']).toBe(1);
  });

  test('O2: the file-import copy of a close is fabricated', () => {
    const importedAt = utc('2026-02-02', '10:00');
    const close = statementClose('c1', utc('2026-01-31'), '100', importedAt);
    const fabricated = classify({
      observations: [close, balanceCopy('f1', new Date(importedAt.getTime() + 30_000), '100')],
      inputs: [STATEMENT_INPUT],
    });
    expect(fabricated.excluded.fabricated).toEqual([
      {
        id: 'f1',
        at: new Date(importedAt.getTime() + 30_000),
        amount: '100',
        role: 'checkpoint',
        authority: 'person',
        cause: null,
        inputId: null,
        supersededAt: null,
        recordedAt: new Date(importedAt.getTime() + 30_000),
      },
    ]);
    expect(fabricated.evidence.observations.map((o) => o.id)).toEqual(['c1']);
    expect(fabricated.labels.observations.map((l) => l.id)).toEqual(['c1']);
    expect(fabricated.notes['obs:O2']).toBe(1);

    const later = classify({
      observations: [close, balanceCopy('f1', new Date(importedAt.getTime() + 200_000), '100')],
      inputs: [STATEMENT_INPUT],
    });
    expect(later.excluded.fabricated).toEqual([]);
    expect(observationById(later, 'f1')).toMatchObject({
      role: 'verification',
      authority: 'person',
    });
    expect(later.notes['obs:O5']).toBe(1);
  });

  test('O2: a copy written 0–120 s after a statement close or a statement ledger row, inclusive', () => {
    const importedAt = utc('2026-02-02', '10:00');
    const statementWrites: Array<[string, Partial<LegacyHoldingEvidence>]> = [
      ['close', { observations: [statementClose('c1', utc('2026-01-31'), '100', importedAt)] }],
      [
        'ledger row',
        {
          transactions: [
            transaction('t1', utc('2026-01-20'), '5', {
              source: 'statement-csv',
              createdAt: importedAt,
            }),
          ],
        },
      ],
    ];
    for (const [written, fields] of statementWrites) {
      const fabricatedAt = [-1_000, 0, 120_000, 121_000].map((offsetMs) => {
        const copy = balanceCopy('f1', new Date(importedAt.getTime() + offsetMs), '105');
        const c = classify({ ...fields, observations: [...(fields.observations ?? []), copy] });
        return [offsetMs, c.excluded.fabricated.map((o) => o.id)];
      });
      expect([written, fabricatedAt]).toEqual([
        written,
        [
          [-1_000, []],
          [0, ['f1']],
          [120_000, ['f1']],
          [121_000, []],
        ],
      ]);
    }
  });

  test('O2: among several statement writes, a copy is measured from the latest one at or before it', () => {
    const importedAt = utc('2026-02-02', '10:00');
    const after = (seconds: number) => new Date(importedAt.getTime() + seconds * 1_000);
    const c = classify({
      observations: [
        statementClose('c3', utc('2026-01-31'), '100', after(2_000)),
        statementClose('c1', utc('2026-01-29'), '100', importedAt),
        statementClose('c2', utc('2026-01-30'), '100', after(1_000)),
        balanceCopy('f1', after(60), '100'),
        balanceCopy('f2', after(500), '100'),
        balanceCopy('f3', after(1_100), '100'),
        balanceCopy('f4', after(2_120), '100'),
        balanceCopy('f5', after(2_121), '100'),
      ],
    });

    expect(c.excluded.fabricated.map((o) => o.id)).toEqual(['f1', 'f3', 'f4']);
  });

  test("O2: a re-upload's copy has no statement write beside it, so it is known by its marker (ruling R21)", () => {
    const importedAt = utc('2026-02-02', '10:00');
    const reuploadedAt = new Date(importedAt.getTime() + 3_600_000);
    const close = statementClose('c1', utc('2026-01-31'), '100', importedAt);
    const read = (copy: EvidenceObservation, observations: EvidenceObservation[] = [close]) => {
      const c = classify({ observations: [...observations, copy], inputs: [STATEMENT_INPUT] });
      return {
        rules: [c.notes['obs:O2'] ?? 0, c.notes['obs:O3'] ?? 0, c.notes['obs:O5'] ?? 0],
        fabricated: c.excluded.fabricated.map((o) => o.id),
        toLabel: c.labels.observations.map((l) => l.id),
      };
    };
    const marked = (at: Date): EvidenceObservation => ({
      ...balanceCopy('f1', at, '100'),
      metadataLegacyAnchor: 'file-import',
    });

    expect({
      // An hour after the statement was written: outside the 120 s window.
      markerOnly: read(marked(reuploadedAt)),
      // With no statement write on the holding at all.
      markerAlone: read(marked(reuploadedAt), []),
      both: read(marked(new Date(importedAt.getTime() + 30_000))),
      // The control: unmarked, the same late row is a value a person typed.
      neither: read(balanceCopy('f1', reuploadedAt, '100')),
    }).toEqual({
      markerOnly: { rules: [1, 0, 0], fabricated: ['f1'], toLabel: ['c1'] },
      markerAlone: { rules: [1, 0, 0], fabricated: ['f1'], toLabel: [] },
      both: { rules: [1, 0, 0], fabricated: ['f1'], toLabel: ['c1'] },
      neither: { rules: [0, 0, 1], fabricated: [], toLabel: ['c1', 'f1'] },
    });
  });

  test('O3: the observation APY writes beside its payout is fabricated', () => {
    const paidAt = utc('2026-01-10', '06:00');
    const payout = transaction('t1', paidAt, '0.5', { kind: 'interest', source: 'apy-payout' });
    const c = classify({
      observations: [
        personValue('o1', utc('2026-01-01'), '100'),
        balanceCopy('f1', paidAt, '100.5'),
      ],
      transactions: [payout],
    });
    expect(c.evidence.kind).toBe('snapshot');
    expect(c.excluded.fabricated.map((o) => [o.id, o.role])).toEqual([['f1', 'snapshot']]);
    expect(c.evidence.observations.map((o) => o.id)).toEqual(['o1']);
    expect(c.evidence.entries.map((e) => [e.id, e.kind])).toEqual([['t1', 'income']]);
    expect(c.notes['obs:O3']).toBe(1);

    const aSecondLater = classify({
      observations: [balanceCopy('f1', new Date(paidAt.getTime() + 1_000), '100.5')],
      transactions: [payout],
    });
    expect(aSecondLater.excluded.fabricated).toEqual([]);
    expect(aSecondLater.notes['obs:O5']).toBe(1);
  });

  test('O3: a run that booked no row has no payout beside its copy, so the copy is known by its marker (ruling R12)', () => {
    const ranAt = utc('2026-01-10', '06:00');
    const read = (c: ClassifiedHolding) => ({
      rules: [c.notes['obs:O3'] ?? 0, c.notes['obs:O5'] ?? 0],
      fabricated: c.excluded.fabricated.map((o) => o.id),
      evidence: c.evidence.observations.map((o) => [o.id, o.role, o.authority]),
      toLabel: c.labels.observations.map((l) => l.id),
      causeUnknown: c.notes['cause-unknown'] ?? 0,
    });

    const opened = personValue('o1', utc('2026-01-01'), '0.000001');

    expect(read(classify({ observations: [opened, apyCopy('f1', ranAt, '0.000001')] }))).toEqual({
      rules: [1, 1],
      fabricated: ['f1'],
      evidence: [['o1', 'snapshot', 'person']],
      toLabel: ['o1'],
      causeUnknown: 0,
    });
    // The control: unmarked, the same row is a value a person typed, with a cause to decide.
    expect(
      read(classify({ observations: [opened, balanceCopy('f1', ranAt, '0.000001')] }))
    ).toEqual({
      rules: [0, 2],
      fabricated: [],
      evidence: [
        ['o1', 'snapshot', 'person'],
        ['f1', 'snapshot', 'person'],
      ],
      toLabel: ['o1', 'f1'],
      causeUnknown: 1,
    });
  });

  test('O3: either arm is enough — the marker, or the payout row beside a copy written before the marker existed (ruling R12)', () => {
    const paidAt = utc('2026-01-10', '06:00');
    const payout = transaction('t1', paidAt, '0.5', { kind: 'interest', source: 'apy-payout' });
    const aSecondLater = new Date(paidAt.getTime() + 1_000);
    const fabricated = (observation: EvidenceObservation, transactions = [payout]) => {
      const c = classify({ observations: [observation], transactions });
      return { rule: c.notes['obs:O3'] ?? 0, ids: c.excluded.fabricated.map((o) => o.id) };
    };

    expect({
      both: fabricated(apyCopy('f1', paidAt, '100.5')),
      markerOnly: fabricated(apyCopy('f1', aSecondLater, '100.5')),
      rowOnly: fabricated(balanceCopy('f1', paidAt, '100.5')),
      neither: fabricated(balanceCopy('f1', aSecondLater, '100.5')),
      // The value is read, not the key's presence: an anchor no rule names is not APY's.
      anotherAnchor: fabricated(
        { ...balanceCopy('f1', aSecondLater, '100.5'), metadataLegacyAnchor: 'some-other-run' },
        []
      ),
    }).toEqual({
      both: { rule: 1, ids: ['f1'] },
      markerOnly: { rule: 1, ids: ['f1'] },
      rowOnly: { rule: 1, ids: ['f1'] },
      neither: { rule: 0, ids: [] },
      anotherAnchor: { rule: 0, ids: [] },
    });
  });

  test("O4: a sync observation is a provider checkpoint on the account's wallet input", () => {
    const c = classify({
      holding: holding({ source: 'blockchain' }),
      observations: [providerSync('k1', utc('2026-01-10'), '100')],
      inputs: [STATEMENT_INPUT, WALLET_INPUT],
    });
    expect(c.evidence.observations).toEqual([
      {
        id: 'k1',
        at: utc('2026-01-10'),
        amount: '100',
        role: 'checkpoint',
        authority: 'provider',
        cause: null,
        inputId: 'in-w',
        supersededAt: null,
        recordedAt: utc('2026-01-10'),
      },
    ]);
    expect(c.notes['obs:O4']).toBe(1);
  });

  test('O4: a holding created by a sync is a checkpoint; one created by hand is a person value', () => {
    const synced = classify({
      holding: holding({ source: 'blockchain' }),
      observations: [
        observation('k1', utc('2026-01-10'), '100', {
          metadataOrigin: 'createHoldingWithEvent',
          metadataSource: 'blockchain',
        }),
      ],
    });
    expect(rolesOf(synced)).toEqual([['k1', 'checkpoint']]);
    expect(synced.evidence.observations[0]?.authority).toBe('provider');

    const typed = classify({
      observations: [
        observation('o1', utc('2026-01-10'), '100', {
          metadataOrigin: 'createHoldingWithEvent',
          metadataSource: 'manual',
        }),
      ],
    });
    expect(typed.evidence.observations[0]).toMatchObject({ role: 'snapshot', authority: 'person' });
    expect(typed.notes['obs:O5']).toBe(1);
  });

  test('O4: a blank creation source reads as manual, as holdings.source does', () => {
    for (const metadataSource of ['', null]) {
      const c = classify({
        observations: [
          observation('o1', utc('2026-01-10'), '100', {
            metadataOrigin: 'createHoldingWithEvent',
            metadataSource,
          }),
        ],
      });
      expect([c.notes['obs:O5'], c.notes['kind:K4'], c.evidence.kind]).toEqual([1, 1, 'snapshot']);
    }
  });

  test('O4: with more than one non-statement input the checkpoint names none', () => {
    const c = classify({
      holding: holding({ source: 'blockchain' }),
      observations: [providerSync('k1', utc('2026-01-10'), '100')],
      inputs: [WALLET_INPUT, input('in-k', 'kraken-api')],
    });
    expect(c.evidence.observations[0]?.inputId).toBeNull();
  });

  test('P: a person value on a feed holding is a verification once the feed has begun, a snapshot before it', () => {
    const byCheckpoint = classify({
      holding: holding({ source: 'blockchain' }),
      observations: [
        personValue('p1', utc('2026-01-05'), '90'),
        providerSync('k1', utc('2026-01-10'), '100'),
        personValue('p2', utc('2026-01-10'), '100'),
        personValue('p3', utc('2026-01-15'), '110'),
      ],
      inputs: [WALLET_INPUT],
    });
    expect(rolesOf(byCheckpoint)).toEqual([
      ['p1', 'snapshot'],
      ['k1', 'checkpoint'],
      ['p2', 'verification'],
      ['p3', 'verification'],
    ]);
    // The instant Rule P reads, returned so a writer labels by the same one (R85).
    expect(byCheckpoint.feedBeganAt).toEqual(utc('2026-01-10'));

    const byLedger = classify({
      holding: holding({ source: 'blockchain' }),
      observations: [
        personValue('p1', utc('2026-01-05'), '90'),
        personValue('p2', utc('2026-01-09'), '100'),
      ],
      transactions: [transaction('t1', utc('2026-01-08'), '10', { source: 'etherscan' })],
    });
    expect(rolesOf(byLedger)).toEqual([
      ['p1', 'snapshot'],
      ['p2', 'verification'],
    ]);
    expect(byLedger.feedBeganAt).toEqual(utc('2026-01-08'));
  });

  test('P: a person value is a snapshot on a snapshot holding, and on a feed holding whose feed never began', () => {
    const snapshotHolding = classify({
      observations: [personValue('p1', utc('2026-01-05'), '90')],
    });
    expect(rolesOf(snapshotHolding)).toEqual([['p1', 'snapshot']]);

    const silentFeed = classify({
      holding: holding({ externalId: 'BTC' }),
      observations: [personValue('p1', utc('2026-01-05'), '90')],
    });
    expect(rolesOf(silentFeed)).toEqual([['p1', 'snapshot']]);
    expect([snapshotHolding.feedBeganAt, silentFeed.feedBeganAt]).toEqual([undefined, undefined]);
  });

  test('P: a persisted person-value role moves only from snapshot to verification', () => {
    const c = classify({
      holding: holding({ source: 'blockchain' }),
      observations: [
        personValue('p1', utc('2026-01-05'), '90', { role: 'verification' }),
        providerSync('k1', utc('2026-01-10'), '100'),
        personValue('p2', utc('2026-01-15'), '110', { role: 'snapshot' }),
      ],
    });
    expect(rolesOf(c)).toEqual([
      ['p1', 'verification'],
      ['k1', 'checkpoint'],
      ['p2', 'verification'],
    ]);
    expect(c.labels.observations.find((l) => l.id === 'p2')?.role).toBeUndefined();
  });
});

describe('causes', () => {
  test('C: cause from the attestation, then the paired edit row, then first-snapshot flow', () => {
    const correctedAt = utc('2026-01-10', '12:00');
    const editedAt = utc('2026-01-12', '12:00');
    const c = classify({
      observations: [
        personValue('s1', utc('2026-01-01'), '100'),
        personValue('s2', utc('2026-01-05'), '120', { gapReview: 'growth' }),
        personValue('s3', correctedAt, '80'),
        personValue('s4', editedAt, '90'),
        personValue('s5', utc('2026-01-15'), '95'),
      ],
      transactions: [
        transaction('t1', utc('2026-01-09'), '-40', {
          kind: 'correction',
          source: 'user-balance-correction',
          createdAt: correctedAt,
        }),
        transaction('t2', utc('2026-01-11'), '10', {
          source: 'user-balance-edit',
          createdAt: editedAt,
        }),
      ],
    });
    expect(causesOf(c)).toEqual([
      ['s1', 'flow'],
      ['s2', 'growth'],
      ['s3', 'correction'],
      ['s4', 'flow'],
      ['s5', null],
    ]);
    expect(c.notes['cause-unknown']).toBe(1);
    expect(c.labels.observations.find((l) => l.id === 's5')).toEqual({
      id: 's5',
      role: 'snapshot',
      authority: 'person',
    });
  });

  test('C: the attestation wins over the paired row and over being first', () => {
    const at = utc('2026-01-10', '12:00');
    const c = classify({
      observations: [
        personValue('s1', utc('2026-01-01'), '100', { gapReview: 'correction' }),
        personValue('s2', at, '80', { gapReview: 'growth' }),
      ],
      transactions: [
        transaction('t1', utc('2026-01-09'), '-20', {
          kind: 'correction',
          source: 'user-balance-correction',
          createdAt: at,
        }),
      ],
    });
    expect(causesOf(c)).toEqual([
      ['s1', 'correction'],
      ['s2', 'growth'],
    ]);
  });

  test('C: an answered "I don\'t know" is a flow, and counted', () => {
    const c = classify({
      observations: [
        personValue('s1', utc('2026-01-01'), '100'),
        personValue('s2', utc('2026-01-05'), '120', { gapReview: BALANCE_GAP_UNKNOWN }),
      ],
    });
    expect(causesOf(c)).toEqual([
      ['s1', 'flow'],
      ['s2', 'flow'],
    ]);
    expect(c.notes['cause-answered-unknown']).toBe(1);
    expect(c.notes['cause-unknown']).toBeUndefined();
  });

  test('C: a checkpoint or a verification has no cause, and the first snapshot is the first snapshot-role row', () => {
    const c = classify({
      holding: holding({ source: 'blockchain' }),
      observations: [
        providerSync('k0', utc('2025-12-20'), '50', {
          gapReview: 'growth',
          supersededAt: utc('2025-12-21'),
        }),
        personValue('p1', utc('2026-01-05'), '90'),
        providerSync('k1', utc('2026-01-10'), '100', { gapReview: 'growth' }),
        personValue('p2', utc('2026-01-15'), '110', { gapReview: 'growth' }),
      ],
    });
    expect(rolesOf(c)).toEqual([
      ['k0', 'checkpoint'],
      ['p1', 'verification'],
      ['k1', 'checkpoint'],
      ['p2', 'verification'],
    ]);
    expect(causesOf(c)).toEqual([
      ['k0', null],
      ['p1', null],
      ['k1', null],
      ['p2', null],
    ]);
    expect(c.labels.observations.filter((l) => l.cause !== undefined)).toEqual([]);
    expect(c.notes['cause-unknown']).toBeUndefined();

    const feedLater = classify({
      holding: holding({ source: 'blockchain' }),
      observations: [
        personValue('p1', utc('2026-01-05'), '90'),
        providerSync('k1', utc('2026-01-10'), '100'),
      ],
    });
    expect(causesOf(feedLater)).toEqual([
      ['p1', 'flow'],
      ['k1', null],
    ]);
  });
});

describe('entries', () => {
  test('an entry carries its D-5 kind and its input, and is labelled with both', () => {
    const c = classify({
      holding: holding({ source: 'blockchain' }),
      transactions: [
        transaction('t1', utc('2026-01-05'), '-1', {
          kind: 'swap_out',
          source: 'etherscan',
          swapGroupId: 'g1',
          priceNative: '50000',
          priceNativeTokenId: 'usd',
        }),
        transaction('t2', utc('2026-01-06'), '3', { source: 'statement-csv' }),
        transaction('t3', utc('2026-01-07'), '4', { source: 'kraken-api' }),
        transaction('t4', utc('2026-01-08'), '5', { source: 'binance-api' }),
      ],
      inputs: [WALLET_INPUT, STATEMENT_INPUT, input('in-k', 'kraken-api')],
    });
    expect(c.evidence.entries).toEqual([
      {
        id: 't1',
        at: utc('2026-01-05'),
        quantity: '-1',
        kind: 'trade_leg',
        kindOrigin: 'source',
        inputId: 'in-w',
      },
      {
        id: 't2',
        at: utc('2026-01-06'),
        quantity: '3',
        kind: 'inflow',
        kindOrigin: 'source',
        inputId: 'in-st',
      },
      {
        id: 't3',
        at: utc('2026-01-07'),
        quantity: '4',
        kind: 'inflow',
        kindOrigin: 'source',
        inputId: 'in-k',
      },
      {
        id: 't4',
        at: utc('2026-01-08'),
        quantity: '5',
        kind: 'inflow',
        kindOrigin: 'source',
        inputId: null,
      },
    ]);
    expect(c.labels.entries[0]).toEqual({
      id: 't1',
      ledgerKind: 'trade_leg',
      groupId: 'g1',
      executionPrice: '50000',
      executionPriceTokenId: 'usd',
      kindOrigin: 'source',
      inputId: 'in-w',
    });
    expect(c.labels.entries[3]).toEqual({ id: 't4', ledgerKind: 'inflow', kindOrigin: 'source' });
  });

  test('opening and correction rows are excluded from entries and listed', () => {
    const c = classify({
      transactions: [
        transaction('t1', utc('2026-01-05'), '10'),
        transaction('t0', utc('2025-12-31'), '50', {
          kind: 'opening_balance',
          source: 'reconciliation-opening',
        }),
        transaction('t2', utc('2026-01-12'), '-20', {
          kind: 'correction',
          source: 'user-balance-correction',
        }),
      ],
    });
    expect(c.evidence.entries.map((e) => e.id)).toEqual(['t1']);
    const excluded = (id: string, at: Date, quantity: string): Entry => ({
      id,
      at,
      quantity,
      kind: null,
      kindOrigin: null,
      inputId: null,
    });
    expect(c.excluded.openings).toEqual([excluded('t0', utc('2025-12-31'), '50')]);
    expect(c.excluded.corrections).toEqual([excluded('t2', utc('2026-01-12'), '-20')]);
    expect(c.labels.entries.map((l) => l.id)).toEqual(['t1']);
  });

  test('an unmapped kind is evidence with no kind, and counted', () => {
    const c = classify({
      transactions: [transaction('t1', utc('2026-01-05'), '2', { kind: 'rebase' })],
    });
    expect(c.evidence.entries.map((e) => [e.id, e.kind, e.kindOrigin])).toEqual([
      ['t1', null, null],
    ]);
    expect(c.notes['unmapped-kind:rebase']).toBe(1);
    expect(c.labels.entries).toEqual([]);
  });

  test('an unknown kind is evidence with no kind, and counted', () => {
    const c = classify({
      transactions: [transaction('t1', utc('2026-01-05'), '0', { kind: 'unknown' })],
    });
    expect(c.evidence.entries.map((e) => [e.id, e.kind, e.kindOrigin])).toEqual([
      ['t1', null, null],
    ]);
    expect(c.notes['kind-unknown']).toBe(1);
    expect(c.labels.entries).toEqual([]);
  });

  test('a row a writer has given a ledger kind is not counted as unknown or unmapped', () => {
    const c = classify({
      transactions: [
        transaction('t1', utc('2026-01-05'), '0', { kind: 'unknown', ledgerKind: 'inflow' }),
        transaction('t2', utc('2026-01-06'), '2', { kind: 'rebase', ledgerKind: 'income' }),
      ],
    });
    expect(c.evidence.entries.map((e) => [e.id, e.kind])).toEqual([
      ['t1', 'inflow'],
      ['t2', 'income'],
    ]);
    expect(c.notes['kind-unknown']).toBeUndefined();
    expect(c.notes['unmapped-kind:rebase']).toBeUndefined();
  });
});

describe('persisted labels', () => {
  test('a persisted label wins over the classifier and is not re-emitted', () => {
    const c = classify({
      observations: [
        personValue('o1', utc('2026-01-05'), '100', {
          role: 'checkpoint',
          authority: 'provider',
        }),
      ],
    });
    expect(c.evidence.observations[0]).toMatchObject({
      id: 'o1',
      role: 'checkpoint',
      authority: 'provider',
      cause: null,
    });
    expect(c.labels.observations).toEqual([]);
  });

  test('each NULL field is labelled on its own', () => {
    const c = classify({
      observations: [personValue('o1', utc('2026-01-05'), '100', { role: 'snapshot' })],
    });
    expect(c.labels.observations).toEqual([{ id: 'o1', authority: 'person', cause: 'flow' }]);

    const withCause = classify({
      observations: [personValue('o1', utc('2026-01-05'), '100', { cause: 'growth' })],
    });
    expect(causesOf(withCause)).toEqual([['o1', 'growth']]);
    expect(withCause.labels.observations).toEqual([
      { id: 'o1', role: 'snapshot', authority: 'person' },
    ]);
  });

  test('a row the classifier would call fabricated stays evidence once it carries a role', () => {
    const paidAt = utc('2026-01-10', '06:00');
    const c = classify({
      observations: [
        observation('f1', paidAt, '100.5', {
          metadataOrigin: 'updateHoldingBalance',
          role: 'snapshot',
        }),
      ],
      transactions: [transaction('t1', paidAt, '0.5', { kind: 'interest', source: 'apy-payout' })],
    });
    expect(c.excluded.fabricated).toEqual([]);
    expect(rolesOf(c)).toEqual([['f1', 'snapshot']]);
  });

  test("a persisted ledger kind keeps its own origin, and the mapping's kind-derived fields are not emitted", () => {
    const c = classify({
      holding: holding({ source: 'blockchain' }),
      transactions: [
        transaction('t1', utc('2026-01-05'), '-1', {
          kind: 'swap_out',
          source: 'etherscan',
          swapGroupId: 'g1',
          ledgerKind: 'outflow',
        }),
      ],
      inputs: [WALLET_INPUT],
    });
    expect(c.evidence.entries).toEqual([
      {
        id: 't1',
        at: utc('2026-01-05'),
        quantity: '-1',
        kind: 'outflow',
        kindOrigin: null,
        inputId: 'in-w',
      },
    ]);
    expect(c.labels.entries).toEqual([{ id: 't1', inputId: 'in-w' }]);
  });

  test('an opening or correction row that carries a ledger kind is evidence, not excluded', () => {
    const c = classify({
      transactions: [
        transaction('t0', utc('2025-12-31'), '50', {
          kind: 'opening_balance',
          source: 'reconciliation-opening',
          ledgerKind: 'inflow',
        }),
        transaction('t2', utc('2026-01-12'), '-20', {
          kind: 'correction',
          source: 'user-balance-correction',
          ledgerKind: 'unexplained_difference',
        }),
      ],
    });
    expect(c.evidence.entries.map((e) => [e.id, e.kind])).toEqual([
      ['t0', 'inflow'],
      ['t2', 'unexplained_difference'],
    ]);
    expect(c.excluded.openings).toEqual([]);
    expect(c.excluded.corrections).toEqual([]);
  });

  test('a persisted cause is carried only on a snapshot-role row', () => {
    const typed = evidence({
      observations: [
        personValue('p1', utc('2026-01-05'), '90'),
        personValue('p2', utc('2026-01-10'), '100', { gapReview: 'growth' }),
      ],
    });
    const persisted = backfilled(typed);
    expect(persisted.observations.map((o) => [o.id, o.role, o.cause])).toEqual([
      ['p1', 'snapshot', 'flow'],
      ['p2', 'snapshot', 'growth'],
    ]);

    // A statement import lands afterwards, with a row dated before both values.
    const importedAt = utc('2026-02-02');
    const withImport = (raw: LegacyHoldingEvidence): LegacyHoldingEvidence => ({
      ...raw,
      observations: [
        ...raw.observations,
        statementClose('c1', utc('2026-01-31'), '120', importedAt),
      ],
      transactions: [
        transaction('t1', utc('2026-01-01'), '5', {
          source: 'statement-csv',
          createdAt: importedAt,
        }),
      ],
    });
    const c = classifyHoldingEvidence(withImport(persisted));
    expect(rolesOf(c)).toEqual([
      ['p1', 'verification'],
      ['p2', 'verification'],
      ['c1', 'checkpoint'],
    ]);
    expect(causesOf(c)).toEqual([
      ['p1', null],
      ['p2', null],
      ['c1', null],
    ]);
    expect(c.evidence).toEqual(classifyHoldingEvidence(withImport(typed)).evidence);
  });

  test('unlabelled counts the labels still to write, and is 0 once they are written', () => {
    const importedAt = utc('2026-02-02', '10:00');
    const raw = evidence({
      holding: holding({ source: 'blockchain' }),
      observations: [
        personValue('p1', utc('2026-01-05'), '90'),
        providerSync('k1', utc('2026-01-10'), '100', {
          role: 'checkpoint',
          authority: 'provider',
          inputId: 'in-w',
        }),
        statementClose('c1', utc('2026-01-31'), '120', importedAt),
        balanceCopy('f1', new Date(importedAt.getTime() + 30_000), '120'),
      ],
      transactions: [
        transaction('t1', utc('2026-01-12'), '5', { source: 'etherscan' }),
        transaction('t0', utc('2025-12-31'), '50', {
          kind: 'opening_balance',
          source: 'reconciliation-opening',
        }),
        transaction('t2', utc('2026-01-13'), '0', { kind: 'unknown' }),
        transaction('t3', utc('2026-01-14'), '1', { kind: 'rebase' }),
      ],
      inputs: [WALLET_INPUT, STATEMENT_INPUT],
    });
    const before = classifyHoldingEvidence(raw);
    expect(before.unlabelled).toEqual({ holding: true, observations: 2, entries: 1 });

    const after = classifyHoldingEvidence(backfilled(raw));
    expect(after.unlabelled).toEqual({ holding: false, observations: 0, entries: 0 });
    expect(after.evidence).toEqual(before.evidence);
    // What stays NULL for good is accounted for elsewhere.
    expect([
      after.excluded.fabricated.length,
      after.excluded.openings.length,
      after.notes['kind-unknown'],
      after.notes['unmapped-kind:rebase'],
    ]).toEqual([1, 1, 1, 1]);

    expect(classify({ holding: holding({ kind: 'snapshot' }) }).unlabelled.holding).toBe(true);
  });
});

describe('stale labels', () => {
  /** One ledger row, classified and its labels written back as the backfill writes them. */
  function labelled(fields: Partial<HoldingTransaction>): LegacyHoldingEvidence {
    return backfilled(
      evidence({
        holding: holding({ source: 'sync_exchange_balances' }),
        transactions: [transaction('t1', utc('2026-01-05'), '1', fields)],
        inputs: [input('in-k', 'kraken-api')],
      })
    );
  }

  /** The same row after a writer changed it, its persisted labels untouched. */
  function rewritten(
    raw: LegacyHoldingEvidence,
    fields: Partial<HoldingTransaction>
  ): LegacyHoldingEvidence {
    const [row] = raw.transactions;
    return { ...raw, transactions: [{ ...(row as HoldingTransaction), ...fields }] };
  }

  const staleOf = (raw: LegacyHoldingEvidence) =>
    classifyHoldingEvidence(raw).notes['stale-label'] ?? 0;

  test('a source label that still matches its row is not stale', () => {
    const raw = labelled({ kind: 'deposit', source: 'kraken-api' });
    expect(raw.transactions[0]).toMatchObject({ ledgerKind: 'inflow', kindOrigin: 'source' });

    expect(staleOf(raw)).toBe(0);
  });

  test('a source label is stale once the transfer linker pairs its row, or a re-import changes its kind', () => {
    const raw = labelled({ kind: 'deposit', source: 'kraken-api' });

    expect(staleOf(rewritten(raw, { transferGroupId: 'g1' }))).toBe(1);
    expect(staleOf(rewritten(raw, { kind: 'withdraw' }))).toBe(1);
    expect(staleOf(rewritten(raw, { kind: 'correction' }))).toBe(1);
  });

  test("a re-import that rewrites a trade leg's price or group makes its label stale", () => {
    const raw = labelled({
      kind: 'buy',
      source: 'kraken-api',
      priceNative: '50000',
      priceNativeTokenId: 'usd',
    });
    expect(raw.transactions[0]).toMatchObject({ executionPrice: '50000', groupId: 't1' });

    expect(staleOf(raw)).toBe(0);
    expect(staleOf(rewritten(raw, { priceNative: '51000' }))).toBe(1);
    expect(staleOf(rewritten(raw, { swapGroupId: 's1' }))).toBe(1);
  });

  test('a person-origin label with no decision behind it goes stale too, and the persisted label still wins', () => {
    const raw = labelled({ kind: 'deposit', source: 'user-entered' });
    expect(raw.transactions[0]).toMatchObject({
      ledgerKind: 'inflow',
      kindOrigin: 'person',
      decisionId: null,
    });
    const paired = rewritten(raw, { transferGroupId: 'g1' });

    expect(staleOf(raw)).toBe(0);
    expect(staleOf(paired)).toBe(1);
    expect(classifyHoldingEvidence(paired).evidence.entries[0]?.kind).toBe('inflow');
  });

  test('a label a decision stands behind is never stale, whatever its origin', () => {
    const person = labelled({ kind: 'deposit', source: 'user-entered', decisionId: 'd1' });
    const source = labelled({ kind: 'deposit', source: 'kraken-api', decisionId: 'd2' });

    expect(staleOf(rewritten(person, { transferGroupId: 'g1' }))).toBe(0);
    expect(staleOf(rewritten(source, { transferGroupId: 'g1' }))).toBe(0);
    expect(staleOf(rewritten(source, { kind: 'withdraw' }))).toBe(0);
  });
});

describe('the evidence', () => {
  test("the account's windows ride along as engine windows", () => {
    const c = classify({
      inputs: [WALLET_INPUT],
      windows: [
        inputWindow('w2', 'in-w', utc('2026-01-10'), utc('2026-01-20')),
        inputWindow('w1', 'in-w', null, utc('2026-01-10')),
      ],
    });
    expect(c.evidence.windows).toEqual([
      { inputId: 'in-w', from: null, to: utc('2026-01-10') },
      { inputId: 'in-w', from: utc('2026-01-10'), to: utc('2026-01-20') },
    ]);
    expect(c.evidence.holdingId).toBe(HOLDING);
  });

  test('the result does not depend on the order the rows arrive in', () => {
    const importedAt = utc('2026-02-02', '10:00');
    const raw = evidence({
      holding: holding({ source: 'blockchain' }),
      observations: [
        personValue('p1', utc('2026-01-05'), '90'),
        personValue('p0', utc('2026-01-05'), '91'),
        providerSync('k1', utc('2026-01-10'), '100'),
        statementClose('c1', utc('2026-01-31'), '120', importedAt),
        balanceCopy('f1', new Date(importedAt.getTime() + 30_000), '120'),
        personValue('p2', utc('2026-02-10'), '125'),
      ],
      transactions: [
        transaction('t2', utc('2026-01-12'), '5', { source: 'etherscan' }),
        transaction('t1', utc('2026-01-12'), '6', { source: 'etherscan' }),
        transaction('t0', utc('2025-12-31'), '50', {
          kind: 'opening_balance',
          source: 'reconciliation-opening',
        }),
      ],
      inputs: [WALLET_INPUT, STATEMENT_INPUT],
      windows: [
        inputWindow('w1', 'in-w', null, utc('2026-01-10')),
        inputWindow('w2', 'in-st', utc('2026-01-01'), utc('2026-01-31')),
      ],
    });
    const reversed: LegacyHoldingEvidence = {
      ...raw,
      observations: raw.observations.toReversed(),
      transactions: raw.transactions.toReversed(),
      inputs: raw.inputs.toReversed(),
      windows: raw.windows.toReversed(),
    };
    const c = classifyHoldingEvidence(raw);
    expect(classifyHoldingEvidence(reversed)).toEqual(c);
    expect(c.evidence.observations.map((o) => o.id)).toEqual(['p0', 'p1', 'k1', 'c1', 'p2']);
    expect(c.evidence.entries.map((e) => e.id)).toEqual(['t1', 't2']);
  });
});
