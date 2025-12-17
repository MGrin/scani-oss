/**
 * usePlaidLink Hook
 *
 * Custom hook for integrating Plaid Link in the Scani frontend.
 * Handles the complete Plaid Link flow:
 * 1. Creates a Link token from backend
 * 2. Initializes Plaid Link SDK
 * 3. Handles successful connection
 * 4. Exchanges public token for access token
 * 5. Triggers account and balance import
 */

import { useEffect, useState } from 'react';
import { usePlaidLink as usePlaidLinkSDK } from 'react-plaid-link';
import { trpc } from '@/lib/trpc';

export interface PlaidLinkConfig {
  /** Optional: Pre-select a specific Plaid institution */
  plaidInstitutionId?: string;
  /** Callback when connection succeeds */
  onSuccess?: (data: PlaidSuccessResult) => void;
  /** Callback when user exits without completing */
  onExit?: (error?: PlaidLinkError) => void;
}

export interface PlaidSuccessResult {
  plaidItemId: string;
  institutionId: string;
  institutionCreated: boolean;
  accountsCreated: number;
  holdingsImported: number;
  errors: string[];
}

export interface PlaidLinkError {
  error_code?: string;
  error_message?: string;
  error_type?: string;
}

/**
 * Hook for integrating Plaid Link
 */
export function usePlaidLink(config: PlaidLinkConfig = {}) {
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Create Link token mutation
  // biome-ignore lint/suspicious/noExplicitAny: tRPC plaid router types not yet generated
  const createLinkTokenMutation = (trpc as any).plaid.createLinkToken.useMutation({
    // biome-ignore lint/suspicious/noExplicitAny: tRPC plaid router types not yet generated
    onSuccess: (data: any) => {
      setLinkToken(data.linkToken);
      setError(null);
    },
    // biome-ignore lint/suspicious/noExplicitAny: tRPC plaid router types not yet generated
    onError: (err: any) => {
      setError(err.message || 'Failed to create Plaid Link token');
      setLinkToken(null);
    },
  });

  // Exchange public token mutation
  // biome-ignore lint/suspicious/noExplicitAny: tRPC plaid router types not yet generated
  const exchangeTokenMutation = (trpc as any).plaid.exchangePublicToken.useMutation({
    // biome-ignore lint/suspicious/noExplicitAny: tRPC plaid router types not yet generated
    onSuccess: (data: any) => {
      setLoading(false);
      if (config.onSuccess) {
        config.onSuccess({
          plaidItemId: data.plaidItemId,
          institutionId: data.institutionId,
          institutionCreated: data.institutionCreated,
          accountsCreated: data.accountsCreated,
          holdingsImported: data.holdingsImported,
          errors: data.errors,
        });
      }
    },
    // biome-ignore lint/suspicious/noExplicitAny: tRPC plaid router types not yet generated
    onError: (err: any) => {
      setLoading(false);
      setError(err.message || 'Failed to connect bank account');
    },
  });

  // Create Link token on mount
  // biome-ignore lint/correctness/useExhaustiveDependencies: mutate function is stable and should not be in dependencies
  useEffect(() => {
    createLinkTokenMutation.mutate({
      plaidInstitutionId: config.plaidInstitutionId,
    });
  }, [config.plaidInstitutionId]);

  // Initialize Plaid Link SDK
  const { open, ready } = usePlaidLinkSDK({
    token: linkToken,
    onSuccess: async (publicToken, metadata) => {
      setLoading(true);
      setError(null);

      // Exchange public token for access token and import accounts
      exchangeTokenMutation.mutate({
        publicToken,
        plaidInstitutionId: metadata.institution?.institution_id || '',
        institutionName: metadata.institution?.name,
      });
    },
    onExit: (err, _metadata) => {
      if (err) {
        setError(err.error_message || 'Plaid Link was closed');
        if (config.onExit) {
          config.onExit({
            error_code: err.error_code,
            error_message: err.error_message,
            error_type: err.error_type,
          });
        }
      } else if (config.onExit) {
        config.onExit();
      }
    },
    onEvent: (_eventName, _metadata) => {
      // Optional: Track Plaid Link events
      // console.log('Plaid Link event:', eventName, metadata);
    },
  });

  return {
    /** Open Plaid Link */
    open,
    /** Whether Plaid Link is ready to open */
    ready: ready && !!linkToken,
    /** Whether an operation is in progress */
    loading: loading || createLinkTokenMutation.isPending || exchangeTokenMutation.isPending,
    /** Error message if any */
    error,
    /** Clear error */
    clearError: () => setError(null),
  };
}
