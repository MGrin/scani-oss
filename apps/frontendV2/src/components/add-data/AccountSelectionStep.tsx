import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  AccountTypeSelector,
  InstitutionSelector,
  InstitutionTypeSelector,
} from '@/components/selectors/SearchableSelectors';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import type { CompleteImportData } from '@/types/addData';

interface AccountSelectionStepProps {
  onValidationChange?: (isValid: boolean) => void;
  onAccountDisplayChange?: (displayText: string) => void;
  onCompleteDataUpdate: (updates: Partial<CompleteImportData>) => void;
}

export function AccountSelectionStep({
  onValidationChange,
  onAccountDisplayChange,
  onCompleteDataUpdate,
}: AccountSelectionStepProps) {
  const [mode, setMode] = useState<'select' | 'create'>('select');
  const accountNameId = useId();
  const institutionNameId = useId();
  const institutionWebsiteId = useId();
  const institutionDescriptionId = useId();
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [newAccountData, setNewAccountData] = useState({
    name: '',
    typeId: '',
    institutionSelection: {
      mode: 'select' as 'select' | 'create',
      selectedInstitutionId: '',
      newInstitutionData: {
        name: '',
        typeId: '',
        website: '',
        description: '',
      },
    },
  });
  const [, setInstitutionMetadata] = useState<{
    title: string;
    description: string;
    siteName: string;
  } | null>(null);
  const [hasFetchedMetadata, setHasFetchedMetadata] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  // Fetch data
  const { data: accounts, isLoading: accountsLoading } = trpc.accounts.getAll.useQuery();
  const { data: institutions } = trpc.institutions.getAll.useQuery();
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();
  const { data: institutionTypes } = trpc.institutionTypes.getAll.useQuery();

  // Automatically switch to create mode if no accounts exist
  useEffect(() => {
    if (!accountsLoading && accounts && accounts.length === 0) {
      setMode('create');
    }
  }, [accountsLoading, accounts]);

  // Query for fetching Open Graph metadata (disabled by default, triggered manually)
  const metadataQuery = trpc.institutions.getOpenGraphMetadata.useQuery(
    { url: newAccountData.institutionSelection.newInstitutionData.website },
    {
      enabled: false, // Don't fetch automatically
      onSuccess: (data) => {
        setInstitutionMetadata(data);
        setHasFetchedMetadata(true);
        // Auto-populate fields with metadata if available
        if (data.title && !newAccountData.institutionSelection.newInstitutionData.name) {
          setNewAccountData((prev) => ({
            ...prev,
            institutionSelection: {
              ...prev.institutionSelection,
              newInstitutionData: {
                ...prev.institutionSelection.newInstitutionData,
                name: data.title,
              },
            },
          }));
        }
        if (
          data.description &&
          !newAccountData.institutionSelection.newInstitutionData.description
        ) {
          setNewAccountData((prev) => ({
            ...prev,
            institutionSelection: {
              ...prev.institutionSelection,
              newInstitutionData: {
                ...prev.institutionSelection.newInstitutionData,
                description: data.description,
              },
            },
          }));
        }
      },
    }
  );

  // Handler for fetching metadata from website
  const handleFetchMetadata = async () => {
    if (!newAccountData.institutionSelection.newInstitutionData.website.trim()) {
      alert('Please enter a website URL first');
      return;
    }

    try {
      await metadataQuery.refetch();
    } catch (error) {
      console.error('Failed to fetch metadata:', error);
      // Even on error, show the form fields
      setHasFetchedMetadata(true);
    }
  };

  // Memoize validation values to prevent infinite re-renders
  const validationValues = useMemo(
    () => ({
      hasAccountDetails: newAccountData.name.trim() !== '' && newAccountData.typeId.trim() !== '',
      hasInstitutionDetails:
        newAccountData.institutionSelection.mode === 'select'
          ? newAccountData.institutionSelection.selectedInstitutionId.trim() !== ''
          : newAccountData.institutionSelection.newInstitutionData.name.trim() !== '' &&
            newAccountData.institutionSelection.newInstitutionData.typeId.trim() !== '',
    }),
    [
      newAccountData.name,
      newAccountData.typeId,
      newAccountData.institutionSelection.mode,
      newAccountData.institutionSelection.selectedInstitutionId,
      newAccountData.institutionSelection.newInstitutionData.name,
      newAccountData.institutionSelection.newInstitutionData.typeId,
    ]
  );

  // Validation function
  const isValidForContinue = useCallback(() => {
    if (mode === 'select') {
      return selectedAccountId.trim() !== '';
    } else if (mode === 'create') {
      return validationValues.hasAccountDetails && validationValues.hasInstitutionDetails;
    }
    return false;
  }, [mode, selectedAccountId, validationValues]);

  // Notify parent of validation changes
  useEffect(() => {
    onValidationChange?.(isValidForContinue());
  }, [onValidationChange, isValidForContinue]);

  // Memoize account data to prevent unnecessary re-renders
  const accountData = useMemo(() => {
    if (!isValidForContinue()) return null;

    return {
      mode,
      selectedAccountId: mode === 'select' ? selectedAccountId : undefined,
      newAccountData: mode === 'create' ? newAccountData : undefined,
    } as NonNullable<CompleteImportData['accountSelection']>;
  }, [mode, selectedAccountId, newAccountData, isValidForContinue]);

  // Store complete account data when valid
  useEffect(() => {
    if (accountData) {
      onCompleteDataUpdate({ accountSelection: accountData });
    }
  }, [accountData, onCompleteDataUpdate]);

  // Update account display text for progress bar
  useEffect(() => {
    let displayText = 'Choose Account';

    if (mode === 'select' && selectedAccountId) {
      const selectedAccount = accounts?.find((a) => a.id === selectedAccountId);
      if (selectedAccount) {
        const institution = institutions?.find((inst) => inst.id === selectedAccount.institutionId);
        displayText = institution
          ? `${institution.name} - ${selectedAccount.name}`
          : selectedAccount.name;
      }
    } else if (mode === 'create' && newAccountData.name.trim()) {
      if (newAccountData.institutionSelection.mode === 'select') {
        const selectedInstitution = institutions?.find(
          (inst) => inst.id === newAccountData.institutionSelection.selectedInstitutionId
        );
        displayText = selectedInstitution
          ? `${selectedInstitution.name} - ${newAccountData.name}`
          : newAccountData.name;
      } else {
        displayText = newAccountData.institutionSelection.newInstitutionData.name
          ? `${newAccountData.institutionSelection.newInstitutionData.name} - ${newAccountData.name}`
          : newAccountData.name;
      }
    }

    onAccountDisplayChange?.(displayText);
  }, [
    mode,
    selectedAccountId,
    newAccountData.name,
    newAccountData.institutionSelection.mode,
    newAccountData.institutionSelection.selectedInstitutionId,
    newAccountData.institutionSelection.newInstitutionData.name,
    accounts,
    institutions,
    onAccountDisplayChange,
  ]);

  const handleAccountSelect = (accountId: string) => {
    setSelectedAccountId(accountId);

    // Store complete account selection data
    onCompleteDataUpdate({
      accountSelection: {
        mode: 'select',
        selectedAccountId: accountId,
      },
    });
  };

  // Filter accounts based on search term
  const filteredAccounts = accounts?.filter((account) => {
    if (!searchTerm.trim()) return true;

    const accountName = account.name.toLowerCase();
    const institution = institutions?.find((inst) => inst.id === account.institutionId);
    const institutionName = institution?.name.toLowerCase() || '';

    const searchLower = searchTerm.toLowerCase();

    return accountName.includes(searchLower) || institutionName.includes(searchLower);
  });

  return (
    <div className="space-y-6">
      {/* Mode Selection */}
      <Card>
        <CardHeader>
          <CardTitle>Choose Account</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            <Card
              className={`cursor-pointer transition-all hover:shadow-md ${
                mode === 'select' ? 'ring-2 ring-primary' : ''
              }`}
              onClick={() => setMode('select')}
            >
              <CardContent className="p-4 md:p-6 text-center">
                <div className="text-2xl md:text-3xl mb-2 md:mb-4">📋</div>
                <h3 className="font-semibold mb-1 md:mb-2 text-sm md:text-base">
                  Select Existing Account
                </h3>
                <p className="text-xs md:text-sm text-muted-foreground">
                  Choose from your existing accounts
                </p>
              </CardContent>
            </Card>

            <Card
              className={`cursor-pointer transition-all hover:shadow-md ${
                mode === 'create' ? 'ring-2 ring-primary' : ''
              }`}
              onClick={() => setMode('create')}
            >
              <CardContent className="p-4 md:p-6 text-center">
                <div className="text-2xl md:text-3xl mb-2 md:mb-4">➕</div>
                <h3 className="font-semibold mb-1 md:mb-2 text-sm md:text-base">
                  Create New Account
                </h3>
                <p className="text-xs md:text-sm text-muted-foreground">
                  Set up a new account and institution
                </p>
              </CardContent>
            </Card>
          </div>
        </CardContent>
      </Card>

      {/* Account Selection */}
      {mode === 'select' && (
        <Card>
          <CardHeader>
            <CardTitle>Select Account</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Search Input - Show skeleton when loading */}
            <div className="mb-4">
              {accountsLoading ? (
                <Skeleton className="h-10 w-full" />
              ) : (
                <Input
                  placeholder="Search accounts by name or institution..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full"
                />
              )}
            </div>

            {/* Account Grid - Show skeletons when loading */}
            {accountsLoading ? (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {['skeleton-1', 'skeleton-2', 'skeleton-3', 'skeleton-4'].map((key) => (
                  <Card key={key}>
                    <CardContent className="p-4">
                      <Skeleton className="h-4 w-3/4 mb-2" />
                      <Skeleton className="h-3 w-1/2 mb-2" />
                      <Skeleton className="h-3 w-2/3" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {filteredAccounts?.map((account) => {
                  const institution = institutions?.find(
                    (inst) => inst.id === account.institutionId
                  );
                  const accountType = accountTypes?.find((type) => type.id === account.typeId);

                  return (
                    <Card
                      key={account.id}
                      className={`cursor-pointer transition-all hover:shadow-md ${
                        selectedAccountId === account.id ? 'ring-2 ring-primary' : ''
                      }`}
                      onClick={() => handleAccountSelect(account.id)}
                    >
                      <CardContent className="p-4">
                        <h4 className="font-medium mb-1">{account.name}</h4>
                        <p className="text-sm text-muted-foreground mb-2">
                          {accountType?.name || 'Unknown Type'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {institution?.name || 'Unknown Institution'}
                        </p>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}

            {/* Empty state - Only show when not loading and no accounts */}
            {!accountsLoading && (!filteredAccounts || filteredAccounts.length === 0) && (
              <div className="text-center py-8 text-muted-foreground">
                {searchTerm.trim() ? (
                  <p>No accounts found matching "{searchTerm}".</p>
                ) : (
                  <p>No accounts found. Try creating a new account instead.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Account Creation */}
      {mode === 'create' && (
        <div className="space-y-6">
          {/* Account Details */}
          <Card>
            <CardHeader>
              <CardTitle>Account Information</CardTitle>
              <p className="text-sm text-muted-foreground">Provide details for your new account</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="account-name">Account Name *</Label>
                  <Input
                    id={accountNameId}
                    placeholder="e.g., Primary Checking, Retirement Portfolio"
                    value={newAccountData.name}
                    onChange={(e) =>
                      setNewAccountData((prev) => ({
                        ...prev,
                        name: e.target.value,
                      }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    Choose a descriptive name for this account
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="account-type">Account Type *</Label>
                  <AccountTypeSelector
                    value={newAccountData.typeId}
                    onValueChange={(value) =>
                      setNewAccountData((prev) => ({ ...prev, typeId: value }))
                    }
                    accountTypes={accountTypes}
                    placeholder="Select account type"
                    allowCreate={false}
                  />
                  <p className="text-xs text-muted-foreground">What kind of account is this?</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Institution Selection */}
          <Card>
            <CardHeader>
              <CardTitle>Institution</CardTitle>
              <p className="text-sm text-muted-foreground">Where is this account held?</p>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Institution Mode Selection */}
              <div className="grid gap-4 md:grid-cols-2">
                <Card
                  className={`cursor-pointer transition-all hover:shadow-md ${
                    newAccountData.institutionSelection.mode === 'select'
                      ? 'ring-2 ring-primary'
                      : ''
                  }`}
                  onClick={() => {
                    setNewAccountData((prev) => ({
                      ...prev,
                      institutionSelection: {
                        ...prev.institutionSelection,
                        mode: 'select',
                        selectedInstitutionId: '',
                        newInstitutionData: {
                          name: '',
                          typeId: '',
                          website: '',
                          description: '',
                        },
                      },
                    }));
                  }}
                >
                  <CardContent className="p-4 md:p-6 text-center">
                    <div className="text-3xl md:text-4xl mb-4">🏦</div>
                    <h3 className="font-semibold mb-2 text-sm md:text-base">
                      Select Existing Institution
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Choose from your previously added institutions
                    </p>
                  </CardContent>
                </Card>

                <Card
                  className={`cursor-pointer transition-all hover:shadow-md ${
                    newAccountData.institutionSelection.mode === 'create'
                      ? 'ring-2 ring-primary'
                      : ''
                  }`}
                  onClick={() => {
                    setNewAccountData((prev) => ({
                      ...prev,
                      institutionSelection: {
                        ...prev.institutionSelection,
                        mode: 'create',
                        selectedInstitutionId: '',
                        newInstitutionData: {
                          name: '',
                          typeId: '',
                          website: '',
                          description: '',
                        },
                      },
                    }));
                  }}
                >
                  <CardContent className="p-4 md:p-6 text-center">
                    <div className="text-3xl md:text-4xl mb-4">🏗️</div>
                    <h3 className="font-semibold mb-2 text-sm md:text-base">
                      Create New Institution
                    </h3>
                    <p className="text-sm text-muted-foreground">
                      Add a new bank, broker, or financial institution
                    </p>
                  </CardContent>
                </Card>
              </div>

              {/* Institution Selection Form */}
              {newAccountData.institutionSelection.mode === 'select' && (
                <div className="space-y-3">
                  <Label className="text-base font-medium">Choose Institution</Label>
                  <InstitutionSelector
                    value={newAccountData.institutionSelection.selectedInstitutionId}
                    onValueChange={(value) =>
                      setNewAccountData((prev) => ({
                        ...prev,
                        institutionSelection: {
                          ...prev.institutionSelection,
                          selectedInstitutionId: value,
                        },
                      }))
                    }
                    institutions={institutions}
                    placeholder="Select an institution"
                    allowCreate={false}
                  />
                  {(!institutions || institutions.length === 0) && (
                    <p className="text-sm text-muted-foreground">
                      No institutions found. Try creating a new institution instead.
                    </p>
                  )}
                </div>
              )}

              {/* New Institution Creation Form */}
              {newAccountData.institutionSelection.mode === 'create' && (
                <div className="space-y-4 p-4 border rounded-lg bg-muted/30">
                  <div className="space-y-2">
                    <Label className="text-base font-medium">Institution Details</Label>
                    <p className="text-xs text-muted-foreground">
                      Provide information about the new institution
                    </p>
                  </div>

                  {/* Website Field - Always visible */}
                  <div className="space-y-2">
                    <Label htmlFor={institutionWebsiteId}>Institution Website</Label>
                    <div className="flex gap-2">
                      <Input
                        id={institutionWebsiteId}
                        type="url"
                        placeholder="https://www.example.com"
                        value={newAccountData.institutionSelection.newInstitutionData.website}
                        onChange={(e) =>
                          setNewAccountData((prev) => ({
                            ...prev,
                            institutionSelection: {
                              ...prev.institutionSelection,
                              newInstitutionData: {
                                ...prev.institutionSelection.newInstitutionData,
                                website: e.target.value,
                              },
                            },
                          }))
                        }
                        disabled={metadataQuery.isFetching}
                        className="flex-1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleFetchMetadata}
                        disabled={
                          !newAccountData.institutionSelection.newInstitutionData.website.trim() ||
                          metadataQuery.isFetching
                        }
                        className="h-10"
                      >
                        {metadataQuery.isFetching ? 'Fetching...' : 'Fetch Info'}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Enter the institution's website to automatically fetch information
                    </p>
                  </div>

                  {/* Additional fields - Show after fetching metadata or when hasFetchedMetadata is true */}
                  {(hasFetchedMetadata || metadataQuery.isFetching) && (
                    <>
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-2">
                          <Label htmlFor={institutionNameId}>Institution Name *</Label>
                          <Input
                            id={institutionNameId}
                            placeholder="e.g., Chase Bank, Fidelity Investments"
                            value={newAccountData.institutionSelection.newInstitutionData.name}
                            onChange={(e) =>
                              setNewAccountData((prev) => ({
                                ...prev,
                                institutionSelection: {
                                  ...prev.institutionSelection,
                                  newInstitutionData: {
                                    ...prev.institutionSelection.newInstitutionData,
                                    name: e.target.value,
                                  },
                                },
                              }))
                            }
                            disabled={metadataQuery.isFetching}
                          />
                          <p className="text-xs text-muted-foreground">
                            Full name of the financial institution
                          </p>
                        </div>

                        <div className="space-y-2">
                          <Label htmlFor="new-institution-type">Institution Type *</Label>
                          <InstitutionTypeSelector
                            value={newAccountData.institutionSelection.newInstitutionData.typeId}
                            onValueChange={(value) =>
                              setNewAccountData((prev) => ({
                                ...prev,
                                institutionSelection: {
                                  ...prev.institutionSelection,
                                  newInstitutionData: {
                                    ...prev.institutionSelection.newInstitutionData,
                                    typeId: value,
                                  },
                                },
                              }))
                            }
                            institutionTypes={institutionTypes}
                            placeholder="Select type"
                            allowCreate={false}
                            disabled={metadataQuery.isFetching}
                          />
                          <p className="text-xs text-muted-foreground">
                            Bank, investment firm, crypto exchange, etc.
                          </p>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor={institutionDescriptionId}>Description</Label>
                        <Input
                          id={institutionDescriptionId}
                          placeholder="Brief description of the institution"
                          value={newAccountData.institutionSelection.newInstitutionData.description}
                          onChange={(e) =>
                            setNewAccountData((prev) => ({
                              ...prev,
                              institutionSelection: {
                                ...prev.institutionSelection,
                                newInstitutionData: {
                                  ...prev.institutionSelection.newInstitutionData,
                                  description: e.target.value,
                                },
                              },
                            }))
                          }
                          disabled={metadataQuery.isFetching}
                        />
                        <p className="text-xs text-muted-foreground">
                          Optional description of the institution's services
                        </p>
                      </div>
                    </>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
