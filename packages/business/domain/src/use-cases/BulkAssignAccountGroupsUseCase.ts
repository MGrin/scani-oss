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

    // An account in a group is a STANDING RULE (SC-386): the account is in the
    // group, and so is every holding it holds now or receives later. So this
    // writes `account_groups` and nothing else — the old cascade onto every
    // visible holding was the snapshot semantic, and it is what left the
    // account claiming a group its newest positions were not in.
    //
    // Removal is not the mirror of addition. Taking an account out has to be
    // total, so `removeAccountGroups` also drops the holdings' own rows — most
    // of which that cascade wrote — or removing the account would change
    // nothing a reader can see.
    await this.groupRepository.addAccountGroups(input.accountIds, input.addedGroupIds);
    await this.groupRepository.removeAccountGroups(input.accountIds, input.removedGroupIds);

    return {
      success: true,
      updatedAccountIds: input.accountIds,
    };
  }
}
