import { Container, Service } from 'typedi';
import { GroupRepository } from '../repositories/GroupRepository';
import { HoldingRepository } from '../repositories/HoldingRepository';

export interface AssignHoldingGroupsInput {
  holdingId: string;
  groupIds: string[];
}

@Service()
export class AssignHoldingGroupsUseCase {
  private readonly groupRepository = Container.get(GroupRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);

  async execute(input: AssignHoldingGroupsInput, userId: string): Promise<{ success: true }> {
    const holding = await this.holdingRepository.findByIdVisible(input.holdingId);
    if (!holding || holding.userId !== userId) {
      throw new Error('Unauthorized access to holding');
    }

    if (input.groupIds.length > 0) {
      const groups = await Promise.all(
        input.groupIds.map((id) => this.groupRepository.findById(id))
      );
      if (groups.some((g) => !g || g.userId !== userId)) {
        throw new Error('Unauthorized access to one or more groups');
      }
    }

    // REPLACE semantics: diff against current state so the underlying
    // ops still go through the diff-based repo methods (which recompute
    // `accountGroups` for the parent account).
    const currentGroups = await this.groupRepository.findGroupsByHoldingId(input.holdingId);
    const currentIds = new Set(currentGroups.map((g) => g.id));
    const desired = new Set(input.groupIds);
    const toAdd = input.groupIds.filter((id) => !currentIds.has(id));
    const toRemove = Array.from(currentIds).filter((id) => !desired.has(id));

    if (toAdd.length > 0) {
      await this.groupRepository.bulkAddHoldingGroups([input.holdingId], toAdd);
    }
    if (toRemove.length > 0) {
      await this.groupRepository.bulkRemoveHoldingGroups([input.holdingId], toRemove);
    }
    if (toAdd.length > 0 || toRemove.length > 0) {
      const parentIds = await this.groupRepository.findParentAccountIdsForHoldings([
        input.holdingId,
      ]);
      if (parentIds.length > 0) {
        await this.groupRepository.recomputeAccountGroups(parentIds);
      }
    }
    return { success: true };
  }
}
