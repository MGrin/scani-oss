import { z } from 'zod';

// Custom validation functions
export const validateRequired = (message = 'This field is required') =>
  z
    .string()
    .min(1, message)
    .transform((str) => str.trim())
    .refine((str) => str.length > 0, {
      message: 'Field cannot be empty or contain only whitespace',
    });

export const validateName = (fieldName = 'Name', minLength = 2, maxLength = 100) =>
  z
    .string()
    .min(1, `${fieldName} is required`)
    .min(minLength, `${fieldName} must be at least ${minLength} characters long`)
    .max(maxLength, `${fieldName} must not exceed ${maxLength} characters`)
    .transform((str) => str.trim())
    .refine((str) => str.length > 0, {
      message: 'Field cannot be empty or contain only whitespace',
    })
    .refine(
      (str: string) => /^[a-zA-Z0-9\s\-_'.&()]+$/.test(str),
      `${fieldName} can only contain letters, numbers, spaces, and common punctuation`
    );

export const validateDescription = (maxLength = 500) =>
  z
    .string()
    .max(maxLength, `Description must not exceed ${maxLength} characters`)
    .transform((str) => str.trim())
    .optional();

export const validatePositiveNumber = (fieldName = 'Amount', maxValue = 1_000_000_000) =>
  z.coerce
    .number({ invalid_type_error: `${fieldName} must be a valid number` })
    .positive(`${fieldName} must be positive`)
    .max(maxValue, `${fieldName} is too large (maximum: ${maxValue.toLocaleString()})`);

export const validateNonNegativeNumber = (fieldName = 'Value', maxValue = 1_000_000_000) =>
  z.coerce
    .number({ invalid_type_error: `${fieldName} must be a valid number` })
    .nonnegative(`${fieldName} must be zero or positive`)
    .max(maxValue, `${fieldName} is too large (maximum: ${maxValue.toLocaleString()})`);

export const validateEmail = () =>
  z
    .string()
    .email('Please enter a valid email address')
    .transform((str) => str.trim().toLowerCase());

export const validateUrl = (optional = true) => {
  const urlSchema = z
    .string()
    .url('Please enter a valid URL')
    .transform((str) => str.trim());

  return optional ? urlSchema.optional() : urlSchema;
};

export const validateAccountNumber = () =>
  z
    .string()
    .transform((str) => str.trim())
    .refine(
      (str) => str.length === 0 || /^[*\d-]+$/.test(str),
      'Account number can only contain digits, dashes, and asterisks'
    )
    .optional();

export const validateDateInPast = (fieldName = 'Date') =>
  z
    .date({ invalid_type_error: `${fieldName} must be a valid date` })
    .refine((date) => date <= new Date(), `${fieldName} cannot be in the future`);

export const validateDateInFuture = (fieldName = 'Date') =>
  z
    .date({ invalid_type_error: `${fieldName} must be a valid date` })
    .refine((date) => date >= new Date(), `${fieldName} cannot be in the past`);

export const validateDateTimeDefault = () =>
  z.date({ invalid_type_error: 'Please select a valid date and time' }).default(() => new Date());

// Pre-built schemas for common entities
export const InstitutionFormSchema = z.object({
  name: validateName('Institution name'),
  type: z.string().min(1, 'Please select an institution type'),
  description: validateDescription(),
  website: validateUrl(true),
});

export const AccountFormSchema = z.object({
  institutionId: validateRequired('Please select an institution'),
  name: validateName('Account name'),
  type: z.string().min(1, 'Please select an account type'),
  accountNumber: validateAccountNumber(),
  description: validateDescription(),
});

export const HoldingFormSchema = z.object({
  accountId: validateRequired('Please select an account'),
  tokenId: validateRequired('Please select a token/asset'),
  balance: z.coerce
    .number({ invalid_type_error: 'Balance must be a valid number' })
    .refine((val) => !Number.isNaN(val), 'Balance must be a valid number'),
});

export const TransactionFormSchema = z
  .object({
    holdingId: validateRequired('Please select a holding/account'),
    type: z.enum(
      ['buy', 'sell', 'deposit', 'withdrawal', 'dividend', 'interest', 'fee', 'transfer', 'other'],
      {
        errorMap: () => ({ message: 'Please select a valid transaction type' }),
      }
    ),
    amount: z.coerce
      .number({ invalid_type_error: 'Amount must be a valid number' })
      .refine((val) => !Number.isNaN(val), 'Amount must be a valid number')
      .refine((val) => val !== 0, 'Amount cannot be zero')
      .refine((val) => Math.abs(val) >= 0.01, 'Amount is too small (minimum: 0.01)')
      .refine((val) => Math.abs(val) <= 1_000_000_000, 'Amount is too large (maximum: 1 billion)'),
    price: validatePositiveNumber('Price', 1_000_000).optional(),
    fee: validateNonNegativeNumber('Fee', 10_000).default(0),
    description: validateDescription(),
    reference: z
      .string()
      .max(100, 'Reference must not exceed 100 characters')
      .transform((str) => str.trim())
      .optional(),
    timestamp: validateDateTimeDefault(),
  })
  .refine(
    (data) => {
      const requiresPrice = ['buy', 'sell'].includes(data.type);
      return !requiresPrice || (data.price !== undefined && data.price > 0);
    },
    {
      message: 'Price is required for buy/sell transactions',
      path: ['price'],
    }
  );

// Form field helpers
export interface FormFieldConfig {
  label: string;
  placeholder?: string;
  helperText?: string;
  required?: boolean;
  autoComplete?: string;
}

export const formFieldConfigs: Record<string, FormFieldConfig> = {
  institutionName: {
    label: 'Institution Name',
    placeholder: 'e.g., Chase Bank, Fidelity',
    required: true,
    autoComplete: 'organization',
  },
  institutionType: {
    label: 'Institution Type',
    required: true,
  },
  institutionWebsite: {
    label: 'Website',
    placeholder: 'https://www.institution.com',
    helperText: 'Optional: Institution website URL',
    autoComplete: 'url',
  },
  accountName: {
    label: 'Account Name',
    placeholder: 'e.g., Main Checking, Investment Account',
    required: true,
  },
  accountType: {
    label: 'Account Type',
    required: true,
  },
  accountNumber: {
    label: 'Account Number',
    placeholder: '****1234 (optional)',
    helperText: 'Optional: Partial account number for identification',
  },
  description: {
    label: 'Description',
    placeholder: 'Optional description or notes',
    helperText: 'Additional details about this item',
  },
  balance: {
    label: 'Balance',
    placeholder: '0.00',
    required: true,
    helperText: 'Current balance or position size',
  },
  transactionAmount: {
    label: 'Amount',
    placeholder: '0.00',
    required: true,
  },
  transactionPrice: {
    label: 'Price per Unit',
    placeholder: '0.00',
    helperText: 'Required for buy/sell transactions',
  },
  timestamp: {
    label: 'Date & Time',
    helperText: 'When this transaction occurred',
    required: true,
  },
};

// Form default values
export const getDefaultFormValues = {
  institution: () => ({
    name: '',
    type: '', // Will be set to the first available type from the backend
    description: '',
    website: '',
  }),

  account: (institutionId?: string) => ({
    institutionId: institutionId || '',
    name: '',
    type: '', // Will be set to the first available type from the backend or left empty
    accountNumber: '',
    description: '',
  }),

  holding: (accountId?: string) => ({
    accountId: accountId || '',
    tokenId: '',
    balance: 0,
  }),

  transaction: (holdingId?: string) => ({
    holdingId: holdingId || '',
    type: 'deposit' as const,
    amount: 0,
    price: undefined,
    fee: 0,
    description: '',
    reference: '',
    timestamp: new Date(),
  }),
};

// Enhanced validation helpers for better UX
export const validateNonEmptyString = (fieldName: string, customMessage?: string) =>
  z
    .string()
    .min(1, customMessage || `${fieldName} is required`)
    .transform((str) => str.trim())
    .refine((str) => str.length > 0, {
      message: customMessage || `${fieldName} cannot be empty or contain only spaces`,
    });

export const validateSelectField = (fieldName: string, options: readonly string[]) =>
  z
    .string()
    .min(1, `Please select a ${fieldName.toLowerCase()}`)
    .refine((val) => options.includes(val), {
      message: `Please select a valid ${fieldName.toLowerCase()}`,
    });

// Validation for monetary amounts with better error messages
export const validateMonetaryAmount = (
  fieldName: string,
  { min = 0.01, max = 1_000_000_000, allowNegative = false } = {}
) => {
  const schema = z.coerce
    .number({
      invalid_type_error: `${fieldName} must be a valid number`,
      required_error: `${fieldName} is required`,
    })
    .refine((val) => !Number.isNaN(val), `${fieldName} must be a valid number`)
    .refine((val) => val !== 0, `${fieldName} cannot be zero`)
    .refine((val) => Math.abs(val) >= min, `${fieldName} must be at least ${min}`)
    .refine(
      (val) => Math.abs(val) <= max,
      `${fieldName} is too large (maximum: ${max.toLocaleString()})`
    );

  const finalSchema = !allowNegative
    ? schema.refine((val) => val > 0, `${fieldName} must be positive`)
    : schema;

  return finalSchema;
};

// Additional form field configurations
export const additionalFormFieldConfigs = {
  fee: {
    label: 'Fee',
    placeholder: '0.00',
    helperText: 'Transaction fee or commission',
  },
  reference: {
    label: 'Reference',
    placeholder: 'Transaction ID, confirmation number, etc.',
    helperText: 'Optional reference number or ID',
  },
};

// Validation helpers for components
export function getFormFieldProps(fieldName: keyof typeof formFieldConfigs) {
  return formFieldConfigs[fieldName] || {};
}

export function validateFormField(value: unknown, schema: z.ZodSchema) {
  try {
    schema.parse(value);
    return { isValid: true, error: null };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        isValid: false,
        error: error.errors[0]?.message || 'Invalid value',
      };
    }
    return {
      isValid: false,
      error: 'Validation error',
    };
  }
}

// Default values for forms
export const getDefaultTimestamp = () => new Date();

// Validation status helpers
export function getValidationIcon(isValid: boolean | null) {
  if (isValid === null) return null;
  return isValid ? '✓' : '✗';
}

export function getValidationColor(isValid: boolean | null) {
  if (isValid === null) return '';
  return isValid ? 'text-green-600' : 'text-red-600';
}
