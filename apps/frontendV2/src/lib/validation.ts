/**
 * Centralized validation configuration and error messages for the application
 */

// Field validation limits and rules
export const FIELD_LIMITS = {
  INSTITUTION_NAME: { min: 1, max: 50, required: true },
  DESCRIPTION: { max: 300, required: false },
  WEBSITE: { max: 100, required: false, pattern: /^https?:\/\/.+/ },
} as const;

// Centralized error messages with contextual guidance
export const ERROR_MESSAGES = {
  // Network and system errors
  NETWORK_ERROR:
    'Unable to connect to the server. Please check your internet connection and try again.',
  TIMEOUT_ERROR: 'The request took too long to complete. Please try again.',
  UNKNOWN_ERROR:
    'Something went wrong. Please try again or contact support if the problem persists.',

  // Institution-specific errors
  INSTITUTION: {
    DUPLICATE_NAME:
      'An institution with this name already exists in your account. Please choose a different name.',
    DELETE_WITH_ACCOUNTS:
      'This institution has linked accounts. Please reassign or delete those accounts first.',
    CREATION_FAILED: 'Failed to create institution. Please check your information and try again.',
    UPDATE_FAILED: 'Failed to update institution. Please check your information and try again.',
    DELETION_FAILED: 'Failed to delete institution. Please try again.',
    NOT_FOUND: 'Institution not found. It may have been deleted by another session.',
  },

  // Validation errors
  VALIDATION: {
    REQUIRED_FIELD: 'This field is required',
    INVALID_URL: 'Please enter a valid URL starting with http:// or https://',
    TOO_LONG: (max: number) => `This field must be at most ${max} characters`,
    TOO_SHORT: (min: number) => `This field must be at least ${min} characters`,
    INVALID_CHARACTERS:
      'Please use only standard characters (letters, numbers, spaces, and common punctuation)',
    FORM_HAS_ERRORS: 'Please review the highlighted fields below and correct any errors.',
  },

  // Success messages
  SUCCESS: {
    INSTITUTION_CREATED: (name: string) => `Institution "${name}" has been created successfully.`,
    INSTITUTION_UPDATED: (name: string) => `Institution "${name}" has been updated successfully.`,
    INSTITUTION_DELETED: (name: string) => `Institution "${name}" has been deleted successfully.`,
  },

  // Loading states
  LOADING: {
    CREATING: 'Creating institution...',
    UPDATING: 'Updating institution...',
    DELETING: 'Deleting institution...',
    VALIDATING: 'Checking availability...',
  },
} as const;

// Helper function to get field-specific validation message
export const getValidationError = (field: keyof typeof FIELD_LIMITS, error: string) => {
  const limits = FIELD_LIMITS[field];

  if (error.includes('required')) {
    return ERROR_MESSAGES.VALIDATION.REQUIRED_FIELD;
  }

  if (error.includes('too long') || error.includes('at most')) {
    return ERROR_MESSAGES.VALIDATION.TOO_LONG(limits.max);
  }

  if (error.includes('too short') || error.includes('at least')) {
    return 'min' in limits ? ERROR_MESSAGES.VALIDATION.TOO_SHORT(limits.min) : error;
  }

  if (error.includes('invalid characters') || error.includes('printable ASCII')) {
    return ERROR_MESSAGES.VALIDATION.INVALID_CHARACTERS;
  }

  if (error.includes('URL') || error.includes('url')) {
    return ERROR_MESSAGES.VALIDATION.INVALID_URL;
  }

  return error; // Fallback to original error
};

// Accessibility helpers
export const createFieldIds = (baseId: string) => ({
  input: baseId,
  error: `${baseId}-error`,
  help: `${baseId}-help`,
  counter: `${baseId}-counter`,
});

// Character count helper with accessibility
export const getCharacterCountMessage = (current: number, max: number) => {
  const remaining = max - current;

  if (remaining < 0) {
    return `${Math.abs(remaining)} characters over the limit`;
  }

  if (remaining === 0) {
    return 'Character limit reached';
  }

  return `${remaining} characters remaining`;
};

// Accessibility announcement helper
export const getCharacterCountAnnouncement = (current: number, max: number) => {
  const remaining = max - current;

  if (remaining < 0) {
    return `Error: ${Math.abs(remaining)} characters over the ${max} character limit`;
  }

  if (remaining <= 10) {
    return `Warning: Only ${remaining} characters remaining`;
  }

  return undefined; // No announcement needed
};
