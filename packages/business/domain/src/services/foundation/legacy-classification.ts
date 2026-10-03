import type {
  FeedInput,
  FeedInputWindow,
  Holding,
  HoldingBalanceObservation,
  HoldingTransaction,
} from '@scani/db/schema';
import { BALANCE_GAP_UNKNOWN, isManualEditCause } from '@scani/shared';
import { compareText } from '../../engine/order';
import {
  type Authority,
  type Entry,
  type HoldingEvidence,
  type HoldingKind,
  type InputWindow,
  type KindOrigin,
  LEDGER_KINDS,
  type LedgerKind,
  type Observation,
  type ObservationRole,
  type SnapshotCause,
} from '../../engine/types';
import {
  MANUAL_EDIT_CORRECTION_SOURCE,
  MANUAL_EDIT_FLOW_SOURCE,
} from '../../lib/person-authored-sources';
import {
  EXCHANGE_BALANCE_SYNC_SOURCE,
  IMPORTED_HOLDING_SOURCE_PREFIX,
  MANUAL_HOLDING_SOURCE,
  WALLET_BALANCE_SYNC_SOURCE,
} from '../holdings/balance-sync-sources';
import {
  APY_LEGACY_ANCHOR,
  APY_PAYOUT_SOURCE,
  BALANCE_COPY_ORIGIN,
  FILE_IMPORT_LEGACY_ANCHOR,
  type InputSourceClass,
  inputSourceClass,
  type LedgerMapping,
  mapLegacyEntry,
  SYNC_CAPTURE_SOURCE,
  UNDERIVABLE_KIND_ORIGINS,
} from './legacy-ledger-kinds';

// The columns classification, the engine and `BalanceAtTimeService` read, and
// no others: the nightly shadow reads a heavy account's whole history through
// these, in the worker's memory.
export type EvidenceHolding = Pick<
  Holding,
  | 'id'
  | 'accountId'
  | 'tokenId'
  | 'source'
  | 'externalId'
  | 'kind'
  | 'startsAt'
  | 'balance'
  | 'lastUpdated'
  | 'createdAt'
>;

/**
 * `source_metadata` is read as the three keys D-6 reads, each only when it is a
 * string, rather than as the whole document.
 */
export type EvidenceObservation = Pick<
  HoldingBalanceObservation,
  | 'id'
  | 'holdingId'
  | 'balance'
  | 'observedAt'
  | 'source'
  | 'gapReview'
  | 'role'
  | 'authority'
  | 'inputId'
  | 'cause'
  | 'supersededAt'
  | 'createdAt'
> & {
  metadataOrigin: string | null;
  metadataSource: string | null;
  metadataLegacyAnchor: string | null;
};

export type EvidenceTransaction = Pick<
  HoldingTransaction,
  | 'id'
  | 'holdingId'
  | 'kind'
  | 'quantity'
  | 'occurredAt'
  | 'externalId'
  | 'source'
  | 'transferGroupId'
  | 'swapGroupId'
  | 'settlesTransactionId'
  | 'priceNative'
  | 'priceNativeTokenId'
  | 'ledgerKind'
  | 'kindSubtype'
  | 'groupId'
  | 'feeOf'
  | 'inputId'
  | 'executionPrice'
  | 'executionPriceTokenId'
  | 'kindOrigin'
  | 'decisionId'
  | 'createdAt'
>;

export type EvidenceInput = Pick<FeedInput, 'id' | 'accountId' | 'source'>;
export type EvidenceWindow = Pick<FeedInputWindow, 'id' | 'inputId' | 'fromAt' | 'toAt'>;

export interface LegacyHoldingEvidence {
  holding: EvidenceHolding;
  /** Ascending (observed_at, id). */
  observations: EvidenceObservation[];
  /** Ascending (occurred_at, id). */
  transactions: EvidenceTransaction[];
  /** The account's inputs and their windows. */
  inputs: EvidenceInput[];
  windows: EvidenceWindow[];
}

interface ObservationLabel {
  id: string;
  role?: ObservationRole;
  authority?: Authority;
  inputId?: string;
  cause?: SnapshotCause;
}

interface EntryLabel {
  id: string;
  ledgerKind?: LedgerKind;
  kindSubtype?: string;
  groupId?: string;
  feeOf?: string;
  inputId?: string;
  executionPrice?: string;
  executionPriceTokenId?: string;
  kindOrigin?: KindOrigin;
}

export interface HoldingLabels {
  holdingId: string;
  holding: { kind?: HoldingKind; startsAt?: Date };
  observations: ObservationLabel[];
  entries: EntryLabel[];
}

export interface ClassifiedHolding {
  evidence: HoldingEvidence;
  /** `fabricated` carries each row as it would anchor, so a shadow can replay it. */
  excluded: { fabricated: Observation[]; openings: Entry[]; corrections: Entry[] };
  /** Only fields that are NULL in the row and non-null classified (D-4). */
  labels: HoldingLabels;
  /**
   * Rows with a label still to write, so 0 straight after a backfill. A row that
   * stays NULL for good is counted in `excluded`, `kind-unknown` or `unmapped-kind:*`.
   */
  unlabelled: { holding: boolean; observations: number; entries: number };
  /**
   * The K and O rule every holding and observation falls under, `kind-unknown`
   * and `unmapped-kind:<k>` for rows with no stored ledger kind that D-5 gives
   * none either, the causes rule C had to decide (`cause-unknown`,
   * `cause-answered-unknown`), and `stale-label` for each ledger label with no
   * decision or classification result behind it that its row has moved away from.
   */
  notes: Record<string, number>;
}

export const STALE_LABEL_NOTE = 'stale-label';

// D-6 K1: the `holdings.source` values a sync or an import writes.
const FEED_HOLDING_SOURCES: ReadonlySet<string> = new Set([
  WALLET_BALANCE_SYNC_SOURCE,
  EXCHANGE_BALANCE_SYNC_SOURCE,
  'statement-import',
  'ingest-backfill',
]);

const STATEMENT_CLOSE_SOURCE = 'statement-close';

// The `source_metadata.origin` stamps of the other `HoldingService` writers D-6 reads.
const PROVIDER_SYNC_ORIGIN = 'updateHoldingBalanceWithEvent';
const CREATED_WITH_EVENT_ORIGIN = 'createHoldingWithEvent';

/** O2: a file import writes its "now" copy within this long after the statement it read. */
const FILE_IMPORT_COPY_WINDOW_MS = 120_000;

type KindRule = 'K1' | 'K2' | 'K3' | 'K4';
type SourceRule = 'O1' | 'O2' | 'O3' | 'O4' | 'O5';

interface ClassifiedEntry {
  exclusion: LedgerMapping['excluded'];
  entry: Entry;
  label: EntryLabel;
  feedSourced: boolean;
}

interface SourcedObservation {
  row: EvidenceObservation;
  rule: SourceRule;
}

/**
 * Turns today's rows into engine evidence (D-5, D-6). A persisted label wins
 * field by field (D-4), except the three that depend on evidence today's
 * writers keep adding: the holding's kind, its `starts_at` and a person
 * value's role are re-derived on every read and move one way only — snapshot
 * to feed, earlier, snapshot to verification — so a read after the backfill
 * classifies a holding exactly as the backfill would have.
 */
export function classifyHoldingEvidence(raw: LegacyHoldingEvidence): ClassifiedHolding {
  const { holding, inputs } = raw;
  const notes: Record<string, number> = {};
  // Copies sorted with `sort`, not `toSorted`: the frontends type-check this graph under ES2022.
  const observations = [...raw.observations].sort(chronological((o) => o.observedAt));
  const transactions = [...raw.transactions].sort(chronological((t) => t.occurredAt));

  const classifiedEntries = transactions.map((row) => {
    const mapping = mapLegacyEntry(row);
    if (row.ledgerKind === null && mapping.excluded === null && mapping.ledgerKind === null) {
      count(
        notes,
        mapping.unmappedKind === null ? 'kind-unknown' : `unmapped-kind:${mapping.unmappedKind}`
      );
    }
    if (isStaleLabel(row, mapping)) count(notes, STALE_LABEL_NOTE);
    return classifyEntry(row, mapping, inputs);
  });
  const entries = classifiedEntries.filter((c) => c.exclusion === null);
  const firstFeedEntry = entries.find((c) => c.feedSourced);

  const sourceFacts = sourceFactsOf(observations, transactions);
  const sourced = observations.map((row): SourcedObservation => {
    const rule = sourceRuleOf(row, sourceFacts);
    count(notes, `obs:${rule}`);
    return { row, rule };
  });

  const kindRule = kindRuleOf(holding, sourced, firstFeedEntry !== undefined);
  count(notes, `kind:${kindRule}`);
  const kind: HoldingKind = holding.kind === 'feed' || kindRule !== 'K4' ? 'feed' : 'snapshot';
  // A row a writer has already given a role is evidence, whatever this rule says of it.
  const isFabricated = (s: SourcedObservation) =>
    (s.rule === 'O2' || s.rule === 'O3') && s.row.role === null;
  const kept = sourced.filter((s) => !isFabricated(s));

  const firstCheckpointAt = kept.find((s) => (s.row.role ?? ruleRole(s.rule)) === 'checkpoint')?.row
    .observedAt;
  const feedBeganAt = earliest([firstCheckpointAt, firstFeedEntry?.entry.at]);

  const evidenceObservations: Observation[] = [];
  const observationLabels: ObservationLabel[] = [];
  let snapshotSeen = false;
  for (const { row, rule } of kept) {
    const role =
      rule === 'O5'
        ? personValueRole(row.role, kind, row.observedAt, feedBeganAt)
        : (row.role ?? 'checkpoint');
    const authority = row.authority ?? ruleAuthority(rule);
    const inputId = row.inputId ?? ruleInput(rule, inputs);
    let cause = row.cause;
    if (role === 'snapshot') {
      if (cause === null) cause = snapshotCause(row, !snapshotSeen, sourceFacts, notes);
      snapshotSeen = true;
    }
    evidenceObservations.push(toObservation(row, { role, authority, inputId, cause }));
    const label: ObservationLabel = { id: row.id };
    fill(label, 'role', row.role, role);
    fill(label, 'authority', row.authority, authority);
    fill(label, 'inputId', row.inputId, inputId);
    fill(label, 'cause', row.cause, cause);
    if (hasFields(label)) observationLabels.push(label);
  }

  const fabricated = sourced.filter(isFabricated).map(({ row, rule }) =>
    toObservation(row, {
      role: kind === 'feed' ? 'checkpoint' : 'snapshot',
      authority: row.authority ?? ruleAuthority(rule),
      inputId: row.inputId,
      cause: row.cause,
    })
  );

  const derivedStart =
    earliest([holding.createdAt, kept[0]?.row.observedAt, entries[0]?.entry.at]) ??
    holding.createdAt;
  const startsAt =
    holding.startsAt !== null && holding.startsAt < derivedStart ? holding.startsAt : derivedStart;

  const holdingLabel: HoldingLabels['holding'] = {};
  if (holding.kind === null) holdingLabel.kind = kind;
  if (holding.startsAt === null) holdingLabel.startsAt = startsAt;
  const entryLabels = entries.map((c) => c.label).filter(hasFields);

  return {
    evidence: {
      holdingId: holding.id,
      kind,
      startsAt,
      observations: evidenceObservations,
      entries: entries.map((c) => c.entry),
      windows: raw.windows.map(toInputWindow).sort(compareWindows),
    },
    excluded: {
      fabricated,
      openings: excludedAs(classifiedEntries, 'opening-row'),
      corrections: excludedAs(classifiedEntries, 'legacy-correction-row'),
    },
    labels: {
      holdingId: holding.id,
      holding: holdingLabel,
      observations: observationLabels,
      entries: entryLabels,
    },
    unlabelled: {
      holding: Object.keys(holdingLabel).length > 0,
      observations: observationLabels.length,
      entries: entryLabels.length,
    },
    notes,
  };
}

/**
 * The D-5 mapping, unless the row already carries a ledger kind. Then the
 * mapping's subtype, group, fee link, execution price and origin describe a
 * kind the row does not have, and only its source-derived input is filled.
 */
function classifyEntry(
  row: EvidenceTransaction,
  mapping: LedgerMapping,
  inputs: readonly EvidenceInput[]
): ClassifiedEntry {
  const inputId = row.inputId ?? inputForSource(row.source, inputs);
  const feedSourced = inputSourceClass(row.source) !== 'none';
  const base = { id: row.id, at: row.occurredAt, quantity: row.quantity, inputId };
  const label: EntryLabel = { id: row.id };
  const persistedKind = persistedLedgerKind(row.ledgerKind);

  if (persistedKind !== null) {
    fill(label, 'inputId', row.inputId, inputId);
    const entry = { ...base, kind: persistedKind, kindOrigin: row.kindOrigin };
    return { exclusion: null, entry, label, feedSourced };
  }
  if (mapping.excluded !== null) {
    const entry = { ...base, kind: null, kindOrigin: row.kindOrigin };
    return { exclusion: mapping.excluded, entry, label, feedSourced };
  }

  const kindOrigin = row.kindOrigin ?? mapping.kindOrigin;
  fill(label, 'ledgerKind', row.ledgerKind, mapping.ledgerKind);
  fill(label, 'kindSubtype', row.kindSubtype, mapping.kindSubtype);
  fill(label, 'groupId', row.groupId, mapping.groupId);
  fill(label, 'feeOf', row.feeOf, mapping.feeOf);
  fill(label, 'inputId', row.inputId, inputId);
  fill(label, 'executionPrice', row.executionPrice, mapping.executionPrice);
  fill(label, 'executionPriceTokenId', row.executionPriceTokenId, mapping.executionPriceTokenId);
  fill(label, 'kindOrigin', row.kindOrigin, kindOrigin);
  const entry = { ...base, kind: mapping.ledgerKind, kindOrigin };
  return { exclusion: null, entry, label, feedSourced };
}

/**
 * A label D-5 wrote that it would no longer write: since then the transfer
 * linker paired the row, or a re-import rewrote its kind, group or price. A
 * `person` label counts, since it is as mapping-derived as a `source` one
 * (D-5). The persisted label still wins (D-4), so this only counts it. A label
 * with a `decision_id` is a decision about the row, and one from a rule, a
 * mirror leg or Jev a classification result, and neither is ever stale.
 */
function isStaleLabel(row: EvidenceTransaction, mapping: LedgerMapping): boolean {
  if (row.ledgerKind === null || row.decisionId !== null) return false;
  if (row.kindOrigin !== null && UNDERIVABLE_KIND_ORIGINS.includes(row.kindOrigin)) return false;
  if (mapping.excluded !== null) return true;
  return (
    mapping.ledgerKind !== row.ledgerKind ||
    mapping.kindSubtype !== row.kindSubtype ||
    mapping.groupId !== row.groupId ||
    mapping.feeOf !== row.feeOf ||
    mapping.executionPrice !== row.executionPrice ||
    mapping.executionPriceTokenId !== row.executionPriceTokenId
  );
}

function excludedAs(
  entries: readonly ClassifiedEntry[],
  exclusion: NonNullable<LedgerMapping['excluded']>
): Entry[] {
  return entries.filter((c) => c.exclusion === exclusion).map((c) => c.entry);
}

function persistedLedgerKind(value: string | null): LedgerKind | null {
  if (value === null) return null;
  if (!isLedgerKind(value)) {
    throw new Error(`holding_transactions.ledger_kind '${value}' is not a ledger kind`);
  }
  return value;
}

function isLedgerKind(value: string): value is LedgerKind {
  return (LEDGER_KINDS as readonly string[]).includes(value);
}

/**
 * D-6 K1–K4: the first matching rule wins. For K3, a statement close (O1) and
 * a source's own balance (O4) are feed evidence as much as a feed's ledger row.
 */
function kindRuleOf(
  holding: EvidenceHolding,
  sourced: readonly SourcedObservation[],
  hasFeedSourcedEntry: boolean
): KindRule {
  if (
    FEED_HOLDING_SOURCES.has(holding.source) ||
    holding.source.startsWith(IMPORTED_HOLDING_SOURCE_PREFIX)
  ) {
    return 'K1';
  }
  if (holding.externalId !== null) return 'K2';
  if (hasFeedSourcedEntry || sourced.some((s) => s.rule === 'O1' || s.rule === 'O4')) return 'K3';
  return 'K4';
}

interface SourceFacts {
  /** `created_at` of every statement close and statement ledger row, ascending. */
  statementWrittenAt: readonly number[];
  /** `created_at` of every APY payout row. */
  apyWrittenAt: ReadonlySet<number>;
  /** The cause a paired balance-edit row gives, by its `created_at`. */
  editCauseAt: ReadonlyMap<number, SnapshotCause>;
}

function sourceFactsOf(
  observations: readonly EvidenceObservation[],
  transactions: readonly EvidenceTransaction[]
): SourceFacts {
  const statementWrittenAt = [
    ...observations.filter((o) => o.source === STATEMENT_CLOSE_SOURCE),
    ...transactions.filter((t) => inputSourceClass(t.source) === 'statement'),
  ]
    .map((row) => row.createdAt.getTime())
    .sort((a, b) => a - b);
  const apyWrittenAt = new Set(
    transactions.filter((t) => t.source === APY_PAYOUT_SOURCE).map((t) => t.createdAt.getTime())
  );
  const editCauseAt = new Map<number, SnapshotCause>();
  for (const t of transactions) {
    const writtenAt = t.createdAt.getTime();
    if (t.source === MANUAL_EDIT_CORRECTION_SOURCE) editCauseAt.set(writtenAt, 'correction');
    else if (t.source === MANUAL_EDIT_FLOW_SOURCE && !editCauseAt.has(writtenAt)) {
      editCauseAt.set(writtenAt, 'flow');
    }
  }
  return { statementWrittenAt, apyWrittenAt, editCauseAt };
}

/** D-6 O1–O5: the first matching rule wins. */
function sourceRuleOf(row: EvidenceObservation, facts: SourceFacts): SourceRule {
  if (row.source === STATEMENT_CLOSE_SOURCE) return 'O1';
  if (row.source !== SYNC_CAPTURE_SOURCE) return 'O5';
  const origin = row.metadataOrigin;
  const writtenAt = row.createdAt.getTime();
  if (origin === BALANCE_COPY_ORIGIN) {
    const statementAt = latestAtOrBefore(facts.statementWrittenAt, writtenAt);
    // The statement write beside it is what marks a copy written before the
    // marker existed; the marker is all a later upload of the same statement
    // leaves, because its rows and its close were written the first time
    // (ruling R21).
    if (
      row.metadataLegacyAnchor === FILE_IMPORT_LEGACY_ANCHOR ||
      (statementAt !== undefined && writtenAt - statementAt <= FILE_IMPORT_COPY_WINDOW_MS)
    ) {
      return 'O2';
    }
    // The payout row is what marks a copy written before the marker existed;
    // the marker is all a run that booked no row leaves (ruling R12).
    if (row.metadataLegacyAnchor === APY_LEGACY_ANCHOR || facts.apyWrittenAt.has(writtenAt)) {
      return 'O3';
    }
    return 'O5';
  }
  if (origin === PROVIDER_SYNC_ORIGIN) return 'O4';
  if (origin === CREATED_WITH_EVENT_ORIGIN) {
    // Blank reads as manual, as `holdings.source = input.source || 'manual'` does
    // (`HoldingService.createHoldingWithEvent`); the stamp's `??` keeps `''`.
    const createdBy = row.metadataSource || MANUAL_HOLDING_SOURCE;
    if (createdBy !== MANUAL_HOLDING_SOURCE) return 'O4';
  }
  return 'O5';
}

/** Binary search, so a statement-heavy holding costs O(n log n) rather than observations × statements. */
function latestAtOrBefore(ascending: readonly number[], at: number): number | undefined {
  let lo = 0;
  let hi = ascending.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ascending[mid]! <= at) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? undefined : ascending[lo - 1];
}

function ruleRole(rule: SourceRule): ObservationRole | null {
  return rule === 'O1' || rule === 'O4' ? 'checkpoint' : null;
}

/**
 * A fabricated copy (O2, O3) was written by no source, so when a shadow replays
 * it as an anchor it ranks lowest and never outranks real evidence at its instant.
 */
function ruleAuthority(rule: SourceRule): Authority {
  if (rule === 'O1') return 'statement';
  if (rule === 'O4') return 'provider';
  return 'person';
}

function ruleInput(rule: SourceRule, inputs: readonly EvidenceInput[]): string | null {
  if (rule === 'O1') return soleInput(inputs, (c) => c === 'statement');
  if (rule === 'O4') return soleInput(inputs, (c) => c === 'provider' || c === 'wallet');
  return null;
}

/**
 * Rule P. A value typed before the feed's first evidence was typed on what was
 * then a snapshot holding (D7); a feed that has never produced evidence has not
 * begun. A persisted role moves only from snapshot to verification.
 */
function personValueRole(
  persisted: ObservationRole | null,
  kind: HoldingKind,
  at: Date,
  feedBeganAt: Date | undefined
): ObservationRole {
  const feedHadBegun = kind === 'feed' && feedBeganAt !== undefined && at >= feedBeganAt;
  const derived: ObservationRole = feedHadBegun ? 'verification' : 'snapshot';
  if (persisted === null || persisted === 'snapshot') return derived;
  return persisted;
}

/** Rule C, for a snapshot-role row with no persisted cause: the first match wins. */
function snapshotCause(
  row: EvidenceObservation,
  isFirstSnapshot: boolean,
  facts: SourceFacts,
  notes: Record<string, number>
): SnapshotCause | null {
  if (isManualEditCause(row.gapReview)) return row.gapReview;
  // An unexplained change counts as money in or out, never gain (SC-1470).
  if (row.gapReview === BALANCE_GAP_UNKNOWN) {
    count(notes, 'cause-answered-unknown');
    return 'flow';
  }
  const paired = facts.editCauseAt.get(row.createdAt.getTime());
  if (paired !== undefined) return paired;
  if (isFirstSnapshot) return 'flow';
  count(notes, 'cause-unknown');
  return null;
}

/**
 * The D-5 `input_id` rule. A provider row needs the input with its own source;
 * a statement or wallet row takes the account's only input of that class.
 */
function inputForSource(source: string, inputs: readonly EvidenceInput[]): string | null {
  const sourceClass = inputSourceClass(source);
  if (sourceClass === 'none') return null;
  const exact = inputs.find((i) => i.source === source);
  if (exact !== undefined) return exact.id;
  if (sourceClass === 'provider') return null;
  return soleInput(inputs, (c) => c === sourceClass);
}

function soleInput(
  inputs: readonly EvidenceInput[],
  accepts: (sourceClass: InputSourceClass) => boolean
): string | null {
  const matching = inputs.filter((i) => accepts(inputSourceClass(i.source)));
  return matching.length === 1 ? (matching[0]?.id ?? null) : null;
}

/**
 * A cause belongs to a snapshot only. One persisted while the row was a
 * snapshot is dropped once its role is re-derived as anything else, so the
 * evidence equals what a fresh classification of the same rows gives.
 */
function toObservation(
  row: EvidenceObservation,
  classified: Pick<Observation, 'role' | 'authority' | 'inputId' | 'cause'>
): Observation {
  return {
    id: row.id,
    at: row.observedAt,
    amount: row.balance,
    ...classified,
    cause: classified.role === 'snapshot' ? classified.cause : null,
    supersededAt: row.supersededAt,
    recordedAt: row.createdAt,
  };
}

function toInputWindow(window: EvidenceWindow): InputWindow {
  return { inputId: window.inputId, from: window.fromAt, to: window.toAt };
}

function compareWindows(a: InputWindow, b: InputWindow): number {
  return (
    compareText(a.inputId, b.inputId) ||
    a.to.getTime() - b.to.getTime() ||
    (a.from?.getTime() ?? Number.NEGATIVE_INFINITY) -
      (b.from?.getTime() ?? Number.NEGATIVE_INFINITY)
  );
}

function fill<L extends { id: string }, K extends Exclude<keyof L, 'id'>>(
  label: L,
  key: K,
  persisted: unknown,
  classified: L[K] | null
): void {
  if (persisted === null && classified !== null && classified !== undefined) {
    label[key] = classified;
  }
}

function hasFields(label: { id: string }): boolean {
  return Object.keys(label).length > 1;
}

function count(notes: Record<string, number>, key: string): void {
  notes[key] = (notes[key] ?? 0) + 1;
}

function earliest(dates: ReadonlyArray<Date | undefined>): Date | undefined {
  let first: Date | undefined;
  for (const date of dates) {
    if (date !== undefined && (first === undefined || date < first)) first = date;
  }
  return first;
}

function chronological<T extends { id: string }>(at: (row: T) => Date) {
  return (a: T, b: T): number => at(a).getTime() - at(b).getTime() || compareText(a.id, b.id);
}
