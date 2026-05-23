import { Container, Service } from 'typedi';
import { AccountRepository } from '../repositories/AccountRepository';
import { GroupRepository } from '../repositories/GroupRepository';

export interface AssignAccountGroupsInput {
  accountId: string;
  groupIds: string[];
}

@Service()
export class AssignAccountGroupsUseCase {
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly groupRepository = Container.get(GroupRepository);

  async execute(input: AssignAccountGroupsInput, userId: string): Promise<{ success: true }> {
    const account = await this.accountRepository.findById(input.accountId);
    if (!account || account.userId !== userId) {
      throw new Error('Unauthorized access to account');
    }

    if (input.groupIds.length > 0) {
      const groups = await Promise.all(
        input.groupIds.map((id) => this.groupRepository.findById(id))
      );
      if (groups.some((g) => !g || g.userId !== userId)) {
        throw new Error('Unauthorized access to one or more groups');
      }
    }

    // Single-account endpoint — route through the bulk path so it picks
    // up the cascade-to-holdings semantics.
    const currentGroups = await this.groupRepository.findGroupsByAccountId(input.accountId);
    const currentIds = new Set(currentGroups.map((g) => g.id));
    const desired = new Set(input.groupIds);
    const addedGroupIds = input.groupIds.filter((id) => !currentIds.has(id));
    const removedGroupIds = Array.from(currentIds).filter((id) => !desired.has(id));

    const holdingIds = await this.groupRepository.findVisibleHoldingIdsForAccounts([
      input.accountId,
    ]);
    if (holdingIds.length > 0) {
      if (addedGroupIds.length > 0) {
        await this.groupRepository.bulkAddHoldingGroups(holdingIds, addedGroupIds);
      }
      if (removedGroupIds.length > 0) {
        await this.groupRepository.bulkRemoveHoldingGroups(holdingIds, removedGroupIds);
      }
    }
    await this.groupRepository.recomputeAccountGroups([input.accountId]);
    return { success: true };
  }
}
