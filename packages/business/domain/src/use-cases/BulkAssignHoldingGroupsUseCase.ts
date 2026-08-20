import { Container, Service } from 'typedi';
import { GroupRepository } from '../repositories/GroupRepository';
import { HoldingRepository } from '../repositories/HoldingRepository';

export interface BulkAssignHoldingGroupsInput {
  holdingIds: string[];
  addedGroupIds: string[];
  removedGroupIds: string[];
}

export interface BulkAssignHoldingGroupsResult {
  success: boolean;
  updatedHoldingIds: string[];
}

@Service()
export class BulkAssignHoldingGroupsUseCase {
  private readonly groupRepository = Container.get(GroupRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);

  async execute(
    input: BulkAssignHoldingGroupsInput,
    userId: string
  ): Promise<BulkAssignHoldingGroupsResult> {
    const userHoldings = await this.holdingRepository.findByUserWithFullDetails(userId);
    const userHoldingIds = new Set(userHoldings.map((h) => h.holding.id));
    const invalidHoldingIds = input.holdingIds.filter((id) => !userHoldingIds.has(id));
    if (invalidHoldingIds.length > 0) {
      throw new Error(
        `Unauthorized: Cannot assign groups to holdings that don't belong to you: ${invalidHoldingIds.join(
          ', '
        )}`
      );
    }

    // Add then remove — the two sets never overlap so order doesn't
    // matter for correctness, but adds-first keeps the DB in a valid
    // intermediate state for any observer.
    if (input.addedGroupIds.length > 0) {
      await this.groupRepository.bulkAddHoldingGroups(input.holdingIds, input.addedGroupIds);
    }
    if (input.removedGroupIds.length > 0) {
      await this.groupRepository.bulkRemoveHoldingGroups(input.holdingIds, input.removedGroupIds);
    }

    // Nothing to recompute: an account's membership is its own standing rule
    // now, not a projection of its holdings' (SC-386). The removal itself is
    // what writes the per-holding veto, in `bulkRemoveHoldingGroups`.
    return { success: true, updatedHoldingIds: input.holdingIds };
  }
}
