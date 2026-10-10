import { createComponentLogger } from '@scani/logging';
import { emitEntityChange } from '@scani/realtime';

const logger = createComponentLogger('changed-holding-users');

/**
 * The users whose holdings a sync run changed, each told once when the run
 * ends. Without it an hourly sync wrote new balances that no open app heard
 * of until a reload (SC-1600). Fire-and-forget: a lost event costs freshness,
 * never the sync.
 */
export class ChangedHoldingUsers {
  private readonly users = new Set<string>();

  /**
   * A written observation is the change. `updated` is not: the wallet sync
   * re-stamps an unchanged balance's cache, so it counts every holding hourly.
   */
  record(userId: string, result: { observationsWritten: number }): void {
    if (result.observationsWritten > 0) this.users.add(userId);
  }

  announce(reason: string): void {
    for (const userId of this.users) {
      try {
        emitEntityChange({
          entityType: 'holding',
          operationType: 'sync',
          userId,
          data: { reason },
        });
      } catch (error) {
        logger.warn({ userId, reason, error }, 'Failed to announce a holding sync');
      }
    }
    this.users.clear();
  }
}
