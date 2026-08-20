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

    // REPLACE semantics against EFFECTIVE membership: `findGroupsByHoldingId`
    // resolves the account's standing rule too, so dropping a group the holding
    // only has through its account is a real removal here — it becomes the
    // per-holding veto rather than a delete of a row that was never there
    // (SC-386).
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
    return { success: true };
  }
}
