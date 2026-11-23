export type CategoryRuleErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_RULE'
  | 'DUPLICATE_RULE'
  | 'RULE_LIMIT'
  | 'REVISION_CONFLICT'
  | 'TOO_MANY_ROWS'
  | 'PREVIEW_LIMIT'
  | 'STALE_PREVIEW'
  | 'PREVIEW_EXPIRED'
  | 'UNDO_CONFLICT'
  | 'ALREADY_UNDONE'
  | 'BUSY'
  | 'NO_CHANGES';
export class CategoryRuleError extends Error {
  constructor(readonly code: CategoryRuleErrorCode) {
    super(code);
    this.name = 'CategoryRuleError';
  }
}
export class CategoryRuleInUseError extends Error {
  constructor(readonly count: number) {
    super('Update or delete the saved rules using this category first.');
    this.name = 'CategoryRuleInUseError';
  }
}
