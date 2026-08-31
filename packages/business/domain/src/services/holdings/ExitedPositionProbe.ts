import type { Holding, Token } from '@scani/db/schema';
import { createComponentLogger } from '@scani/logging';
import type { BalanceProvider } from '@scani/providers/core/capabilities';
import type { HoldingSnapshot } from '@scani/providers/core/types';
import { Decimal } from '@scani/shared';
import { Service } from 'typedi';
import { SCAM_PROBABILITY_THRESHOLD } from '../../lib/constants';
import { WALLET_BALANCE_SYNC_SOURCE } from './balance-sync-sources';

const logger = createComponentLogger('service:exited-position-probe');

/**
 * The slice of an account's holding rows the exit probe reads.
 *
 * Structural rather than `HoldingWithFullDetails` so a test can hand it two
 * literals: what this needs is a key to ask about, whether the sync owns the
 * row, and the token identity to write the zero back under.
 */
export interface HoldingProbeCandidate {
  holding: Pick<Holding, 'externalId' | 'source' | 'isHidden' | 'balance'>;
  token: Pick<
    Token,
    | 'symbol'
    | 'name'
    | 'decimals'
    | 'iconUrl'
    | 'marketSegment'
    | 'providerMetadata'
    | 'isScamProbability'
  >;
}

export interface ExitedPositionProbeResult {
  /** One `'0'` snapshot per position measured gone, carrying the row's own token identity. */
  snapshots: HoldingSnapshot[];
  /** Uppercased symbols of those positions. */
  exitedSymbols: string[];
}

/**
 * The stuck rows, asked about DIRECTLY, and the two answers separated
 * (SC-852).
 *
 * `fetchBalances` discovers what a wallet holds and drops every zero, so
 * "this token left the wallet" and "discovery failed to reach it" arrive as
 * the same absence. `staleStrategy: 'preserve'` then keeps the old number —
 * correct for the second cause, and the reason a position the chain reports
 * as `0x0` can sit on a dashboard for months. Softening the toast would not
 * have fixed it: the number itself was wrong.
 *
 * `probePositions` is a different question, not a better inference. Each
 * candidate's balance is READ, which is the same standard `fetchExitedPositions`
 * holds itself to and the only one that may anchor a holding at zero —
 * `holdings.balance` is an anchor rather than a sum, so a wrong zero rewrites
 * the reconstructed history behind it.
 *
 * FOUR THINGS BOUND THE COST, and they are what make this affordable on a
 * rate-limit window `OutflowRateLimiterRegistry` shares across all four
 * machines. Candidates must be this account's, owned by the wallet sync, at a
 * non-zero balance, and absent from the snapshot just returned. That is
 * usually 0-2 rows; the whole holdings table is not the population.
 *
 * The visibility filter is what the refresh path's `existingSymbols` is built
 * from. Hidden and scam-flagged rows resolve no warning anyone reads, so
 * probing them would spend the shared budget on dust.
 *
 * THREE OUTCOMES, and only one of them writes anything:
 *
 *   `exited`     -> a snapshot at `'0'`, into the same persistence pass the
 *                   balances take. It corrects the existing row and creates
 *                   nothing: every candidate is by construction a row that
 *                   already exists.
 *   `held`       -> the discovery blind spot. The old number stays, which is
 *                   what `staleStrategy: 'preserve'` exists for.
 *   `unreadable` -> nobody knows. Same treatment as `held`, for the opposite
 *                   reason. THE TWO MUST NOT COLLAPSE INTO ONE STATE WITH
 *                   `exited`: a provider outage answering `unreadable` across
 *                   every candidate would otherwise anchor every wallet on the
 *                   platform at zero in a single unattended run, and nobody is
 *                   watching a cron.
 *
 * A FAILURE HERE COSTS THE SPLIT AND NOTHING ELSE. The balances are already in
 * hand, so a throwing probe degrades to the pre-SC-852 behaviour — every
 * absence unresolved — rather than failing the caller.
 *
 * Shared by the manual refresh (`RefreshAccountBalanceUseCase`) and the hourly
 * unattended sync (`SyncWalletBalancesUseCase`, SC-872). One implementation on
 * purpose: the three states are the whole point, and a second copy is a second
 * place for them to collapse into two.
 */
@Service()
export class ExitedPositionProbe {
  async probe(args: {
    provider: Pick<BalanceProvider, 'probePositions'>;
    ctx: Parameters<NonNullable<BalanceProvider['probePositions']>>[0];
    holdings: readonly HoldingProbeCandidate[];
    snapshots: readonly HoldingSnapshot[];
    capturedAt: Date;
  }): Promise<ExitedPositionProbeResult> {
    const empty = { snapshots: [] as HoldingSnapshot[], exitedSymbols: [] as string[] };
    if (!args.provider.probePositions) return empty;

    const returned = new Set(args.snapshots.map((s) => s.externalId.toLowerCase()));
    const candidates = new Map<string, HoldingProbeCandidate>();
    for (const row of args.holdings) {
      const externalId = row.holding.externalId;
      if (!externalId) continue;
      if (row.holding.source !== WALLET_BALANCE_SYNC_SOURCE) continue;
      if (row.holding.isHidden) continue;
      if (Number(row.token.isScamProbability ?? 0) >= SCAM_PROBABILITY_THRESHOLD) continue;
      // Already at zero: nothing to correct, and the probe would spend a call
      // to confirm the number that is already on the screen.
      if (new Decimal(row.holding.balance ?? '0').isZero()) continue;
      if (returned.has(externalId.toLowerCase())) continue;
      if (candidates.has(externalId)) continue;
      candidates.set(externalId, row);
    }
    if (candidates.size === 0) return empty;

    let probes: Awaited<ReturnType<NonNullable<BalanceProvider['probePositions']>>>;
    try {
      probes = await args.provider.probePositions(args.ctx, [...candidates.keys()]);
    } catch (error) {
      logger.warn(
        {
          externalIds: [...candidates.keys()],
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not probe absent positions — every absence stays unresolved'
      );
      return empty;
    }

    const snapshots: HoldingSnapshot[] = [];
    const exitedSymbols: string[] = [];
    for (const probe of probes) {
      if (probe.state !== 'exited') continue;
      const candidate = candidates.get(probe.externalId);
      // A probe about something nobody asked about anchors a holding this
      // account may not even own. Drop it rather than trusting the key back.
      if (!candidate) continue;
      const { token } = candidate;
      snapshots.push({
        externalId: probe.externalId,
        // Built from the token row already on the holding rather than from
        // anything the probe returned: the snapshot has to resolve back to
        // THIS token for `dedupStrategy: 'externalId'` to find the existing
        // row, and the row's own identity is the only thing guaranteed to.
        tokenIdentity: {
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          iconUrl: token.iconUrl,
          marketSegment: token.marketSegment,
          providerMetadata: token.providerMetadata,
        },
        balance: '0',
        capturedAt: args.capturedAt,
      });
      const symbol = (token.symbol ?? '').toUpperCase();
      if (symbol.length > 0) exitedSymbols.push(symbol);
    }
    return { snapshots, exitedSymbols };
  }
}
