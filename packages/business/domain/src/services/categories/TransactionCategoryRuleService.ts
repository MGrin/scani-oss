import type { DatabaseTransaction } from '@scani/db';
import {
  type CategoryRuleSave,
  categoryRuleSaveSchema,
  categoryRuleScopeSchema,
  type RuleApplyResult,
  type RulePreview,
  type RuleRecentOperations,
  type RuleScope,
  type RuleUndoResult,
  type SavedCategoryRule,
} from '@scani/shared';
import { Container, Service } from 'typedi';
import { TransactionCategoryRuleRepository } from '../../repositories/TransactionCategoryRuleRepository';
import { CategoryRuleError } from './category-rule-errors';

@Service()
export class TransactionCategoryRuleService {
  private readonly repo = Container.get(TransactionCategoryRuleRepository);

  async list(userId: string, tx?: DatabaseTransaction): Promise<SavedCategoryRule[]> {
    return this.repo.list(userId, tx);
  }
  async save(
    userId: string,
    input: CategoryRuleSave,
    tx?: DatabaseTransaction
  ): Promise<SavedCategoryRule> {
    const parsed = categoryRuleSaveSchema.safeParse(input);
    if (!parsed.success) throw new CategoryRuleError('INVALID_RULE');
    return this.repo.save(userId, parsed.data, tx);
  }
  async remove(
    userId: string,
    id: string,
    expectedRevision: number,
    tx?: DatabaseTransaction
  ): Promise<void> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1)
      throw new CategoryRuleError('INVALID_RULE');
    return this.repo.remove(userId, id, expectedRevision, tx);
  }
  async preview(userId: string, scope: RuleScope, tx?: DatabaseTransaction): Promise<RulePreview> {
    const parsed = categoryRuleScopeSchema.safeParse(scope);
    if (!parsed.success) throw new CategoryRuleError('INVALID_RULE');
    return this.repo.preview(userId, parsed.data, tx);
  }
  async apply(userId: string, id: string, tx?: DatabaseTransaction): Promise<RuleApplyResult> {
    return this.repo.apply(userId, id, tx);
  }
  async undo(userId: string, id: string, tx?: DatabaseTransaction): Promise<RuleUndoResult> {
    return this.repo.undo(userId, id, tx);
  }
  async recent(userId: string, tx?: DatabaseTransaction): Promise<RuleRecentOperations> {
    return this.repo.recent(userId, tx);
  }
}
