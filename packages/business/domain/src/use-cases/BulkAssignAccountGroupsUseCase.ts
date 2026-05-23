import { Container, Service } from 'typedi';
import { AccountRepository } from '../repositories/AccountRepository';
import { GroupRepository } from '../repositories/GroupRepository';

export interface BulkAssignAccountGroupsInput {
  accountIds: string[];
  addedGroupIds: string[];
  removedGroupIds: string[];
}

export interface BulkAssignAccountGroupsResult {
  success: boolean;
  updatedAccountIds: string[];
}

@Service()
export class BulkAssignAccountGroupsUseCase {
  private readonly accountRepository = Container.get(AccountRepository);
  private readonly groupRepository = Container.get(GroupRepository);

  async execute(
    input: BulkAssignAccountGroupsInput,
    userId: string
  ): Promise<BulkAssignAccountGroupsResult> {
    const userAccounts = await this.accountRepository.findByUser(userId);
    const userAccountIds = new Set(userAccounts.map((a) => a.id));

    const invalidAccountIds = input.accountIds.filter((id) => !userAccountIds.has(id));
    if (invalidAccountIds.length > 0) {
      throw new Error(
        `Unauthorized: Cannot assign groups to accounts that don't belong to you: ${invalidAccountIds.join(
          ', '
        )}`
      );
    }

    // Account membership is derived from holding membership: an account
    // is "in" group G iff every visible holding of the account is in G.
    // So an account-level group add cascades down to every visible
    // holding of each account, and a removal is the symmetric operation.
    // The accountGroups table is a cache and gets rebuilt after the
    // holding-layer writes.
    const holdingIds = await this.groupRepository.findVisibleHoldingIdsForAccounts(
      input.accountIds
    );

    if (holdingIds.length > 0) {
      if (input.addedGroupIds.length > 0) {
        await this.groupRepository.bulkAddHoldingGroups(holdingIds, input.addedGroupIds);
      }
      if (input.removedGroupIds.length > 0) {
        await this.groupRepository.bulkRemoveHoldingGroups(holdingIds, input.removedGroupIds);
      }
    }

    // Always recompute — even if the account had zero holdings and
    // therefore nothing actually changed at the holding layer — because
    // the cache may be holding stale rows from before this model was
    // introduced.
    await this.groupRepository.recomputeAccountGroups(input.accountIds);

    return {
      success: true,
      updatedAccountIds: input.accountIds,
    };
  }
}
