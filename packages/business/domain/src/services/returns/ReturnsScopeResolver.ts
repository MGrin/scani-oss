import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { GroupRepository } from '../../repositories/GroupRepository';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { VaultRepository } from '../../repositories/VaultRepository';

/**
 * What "this portfolio" means when a return is asked for (SC-457).
 *
 * Every level the product already has a page for. They all reduce to the same
 * thing — a set of holdings, each with a weight — so exactly one series
 * builder and one flow classifier serve all six, and a group return cannot
 * disagree with the whole-portfolio return about what a deposit is.
 */
export type ReturnsScope =
  | { kind: 'user' }
  | { kind: 'holding'; id: string }
  | { kind: 'account'; id: string }
  | { kind: 'institution'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'vault'; id: string };

export interface WeightedHolding {
  holdingId: string;
  /**
   * The fraction of this holding that belongs to the scope, `1` everywhere
   * except a vault. Applied to the VALUE and to the FLOWS alike — scaling only
   * one of them would turn a vault's deposits into performance.
   */
  weight: Decimal;
}

/**
 * A scope resolved to the holdings it is made of.
 *
 * `null` from `resolve` means the scope does not exist or is not this user's,
 * which is not the same as a scope that exists and is empty — the caller
 * renders one as an error and the other as "nothing here yet".
 */
@Service()
export class ReturnsScopeResolver {
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly groupRepository = Container.get(GroupRepository);
  private readonly vaultRepository = Container.get(VaultRepository);

  async resolve(userId: string, scope: ReturnsScope): Promise<WeightedHolding[] | null> {
    switch (scope.kind) {
      case 'user':
        return whole(await this.holdingRepository.findIdsForUser(userId));
      case 'account':
        return whole(await this.holdingRepository.findIdsForUser(userId, { accountId: scope.id }));
      case 'institution':
        return whole(
          await this.holdingRepository.findIdsForUser(userId, { institutionId: scope.id })
        );
      case 'holding': {
        // Ownership is checked by asking for the user's own ids rather than by
        // reading the row and comparing — a holding id from another user then
        // resolves to nothing rather than to a series.
        const owned = await this.holdingRepository.findIdsForUser(userId);
        return owned.includes(scope.id) ? whole([scope.id]) : null;
      }
      case 'group': {
        const group = await this.groupRepository.findById(scope.id);
        if (!group || group.userId !== userId) return null;
        const rows = await this.groupRepository.findHoldingIdsByGroupIds(userId, [scope.id]);
        return whole([...new Set(rows.map((row) => row.holdingId))]);
      }
      case 'vault': {
        const vault = await this.vaultRepository.findById(scope.id);
        if (!vault || vault.userId !== userId) return null;
        const rows = await this.vaultRepository.findVaultHoldings(scope.id);
        // `vault_holdings.percentage` has no history — there is one current
        // number per attachment and no record of what it was last March. So
        // today's split is applied across the whole window, which is exact for
        // the overwhelmingly common 100% case and an approximation for a
        // vault whose share was changed mid-window. Stated rather than
        // silently assumed; giving it history is a schema change and its own
        // ticket.
        return rows.map((row) => ({
          holdingId: row.holding.id,
          weight: new Decimal(row.vaultHolding.percentage).div(100),
        }));
      }
    }
  }
}

function whole(holdingIds: readonly string[]): WeightedHolding[] {
  return holdingIds.map((holdingId) => ({ holdingId, weight: new Decimal(1) }));
}
