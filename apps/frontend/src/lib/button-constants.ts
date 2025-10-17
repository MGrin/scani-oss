/**
 * Standardized button text constants for consistent CTA labeling across the app.
 * This ensures all Create, Add, Edit, Delete, Save actions use consistent language.
 */

export const BUTTON_TEXT = {
  // Primary actions
  CREATE: 'Create',
  ADD: 'Add',
  SAVE: 'Save',
  UPDATE: 'Update',
  EDIT: 'Edit',
  DELETE: 'Delete',
  CANCEL: 'Cancel',
  CONFIRM: 'Confirm',

  // Entity-specific create/add actions
  CREATE_INSTITUTION: 'Add Institution',
  CREATE_ACCOUNT: 'Add Account',
  CREATE_HOLDING: 'Add Holding',

  // Entity-specific edit actions
  EDIT_INSTITUTION: 'Edit Institution',
  EDIT_ACCOUNT: 'Edit Account',
  EDIT_HOLDING: 'Edit Holding',

  // Entity-specific delete actions
  DELETE_INSTITUTION: 'Remove My Accounts',
  DELETE_ACCOUNT: 'Delete Account',
  DELETE_HOLDING: 'Delete Holding',

  // Form submit actions
  SAVE_CHANGES: 'Save Changes',
  CREATE_INSTITUTION_SUBMIT: 'Create Institution',
  CREATE_ACCOUNT_SUBMIT: 'Create Account',
  CREATE_HOLDING_SUBMIT: 'Create Holding',
  UPDATE_INSTITUTION_SUBMIT: 'Update Institution',
  UPDATE_ACCOUNT_SUBMIT: 'Update Account',
  UPDATE_HOLDING_SUBMIT: 'Update Holding',

  // Empty state actions
  ADD_FIRST_INSTITUTION: 'Add Your First Institution',
  ADD_FIRST_ACCOUNT: 'Add Your First Account',
  ADD_FIRST_HOLDING: 'Add Your First Holding',

  // Settings actions
  EXPORT_DATA: 'Export Data',
  IMPORT_DATA: 'Import Data',
  DELETE_ALL_DATA: 'Delete All Data',
  SAVE_PREFERENCES: 'Save Preferences',

  // Navigation actions
  GO_TO_INSTITUTIONS: 'View Institutions',
  GO_TO_ACCOUNTS: 'View Accounts',
  GO_TO_HOLDINGS: 'View Holdings',

  // Other common actions
  VIEW_DETAILS: 'View Details',
  CLOSE: 'Close',
  DONE: 'Done',
  CONTINUE: 'Continue',
  BACK: 'Back',
  NEXT: 'Next',
  SUBMIT: 'Submit',
  RESET: 'Reset',
  CLEAR: 'Clear',
} as const;

/**
 * Button text helpers for dynamic content
 */
export const getCreateButtonText = (entityType: string): string => {
  const entityMap = {
    institution: BUTTON_TEXT.CREATE_INSTITUTION,
    account: BUTTON_TEXT.CREATE_ACCOUNT,
    holding: BUTTON_TEXT.CREATE_HOLDING,
  };
  return entityMap[entityType as keyof typeof entityMap] || `${BUTTON_TEXT.CREATE} ${entityType}`;
};

export const getEditButtonText = (entityType: string): string => {
  const entityMap = {
    institution: BUTTON_TEXT.EDIT_INSTITUTION,
    account: BUTTON_TEXT.EDIT_ACCOUNT,
    holding: BUTTON_TEXT.EDIT_HOLDING,
  };
  return entityMap[entityType as keyof typeof entityMap] || `${BUTTON_TEXT.EDIT} ${entityType}`;
};

export const getDeleteButtonText = (entityType: string): string => {
  const entityMap = {
    institution: BUTTON_TEXT.DELETE_INSTITUTION,
    account: BUTTON_TEXT.DELETE_ACCOUNT,
    holding: BUTTON_TEXT.DELETE_HOLDING,
  };
  return entityMap[entityType as keyof typeof entityMap] || `${BUTTON_TEXT.DELETE} ${entityType}`;
};

export const getEmptyStateButtonText = (entityType: string): string => {
  const entityMap = {
    institution: BUTTON_TEXT.ADD_FIRST_INSTITUTION,
    account: BUTTON_TEXT.ADD_FIRST_ACCOUNT,
    holding: BUTTON_TEXT.ADD_FIRST_HOLDING,
  };
  return entityMap[entityType as keyof typeof entityMap] || `Add Your First ${entityType}`;
};

export const getFormSubmitButtonText = (mode: 'create' | 'edit', entityType: string): string => {
  if (mode === 'create') {
    const entityMap = {
      institution: BUTTON_TEXT.CREATE_INSTITUTION_SUBMIT,
      account: BUTTON_TEXT.CREATE_ACCOUNT_SUBMIT,
      holding: BUTTON_TEXT.CREATE_HOLDING_SUBMIT,
    };
    return entityMap[entityType as keyof typeof entityMap] || `${BUTTON_TEXT.CREATE} ${entityType}`;
  } else {
    const entityMap = {
      institution: BUTTON_TEXT.UPDATE_INSTITUTION_SUBMIT,
      account: BUTTON_TEXT.UPDATE_ACCOUNT_SUBMIT,
      holding: BUTTON_TEXT.UPDATE_HOLDING_SUBMIT,
    };
    return entityMap[entityType as keyof typeof entityMap] || `${BUTTON_TEXT.UPDATE} ${entityType}`;
  }
};
