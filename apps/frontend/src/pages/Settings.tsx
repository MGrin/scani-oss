import { Download, FileText, HelpCircle, Trash2, Upload, User } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useState } from 'react';

import { CurrencySelector } from '@/components/selectors/SearchableSelectors';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useConfirmation } from '@/components/ui/confirmation-modal';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

export function Settings() {
  const { toast } = useToast();
  const { confirm, ConfirmationComponent } = useConfirmation();
  const [activeSection, setActiveSection] = useState('general');

  // Data fetching
  const { data: userPrefs, isLoading } = trpc.users.getCurrent.useQuery();
  const { data: supportedCurrencies } = trpc.users.getSupportedCurrencies.useQuery();
  const utils = trpc.useUtils();
  const updateUserPrefs = trpc.users.updateCurrent.useMutation({
    onSuccess: async () => {
      // Manually invalidate to ensure fresh data
      await utils.users.getCurrent.invalidate();
    },
  });

  // Unified form state - only persisted settings (email is read-only)
  type FormData = {
    name: string;
    email: string; // Keep for display purposes but won't be in updates
    avatar: string;
    baseCurrencyId: string | '';
  };

  const [formData, setFormData] = useState<FormData | null>(null);
  const [originalData, setOriginalData] = useState<FormData | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);

  // Initialize or refresh form state when userPrefs loads/changes
  // BUT don't reinitialize if we just saved (to prevent dirty state reset)
  useEffect(() => {
    if (!userPrefs) return;

    // Don't reinitialize while we're saving to prevent dirty state reset
    if (isSaving) return;

    const initial: FormData = {
      name: userPrefs.name || '',
      email: userPrefs.email || '',
      avatar: userPrefs.avatar || '',
      baseCurrencyId: userPrefs.baseCurrencyId || '',
    };
    setFormData(initial);
    setOriginalData(initial);
  }, [userPrefs, isSaving]);

  const isDirty = useMemo(() => {
    if (!formData || !originalData) return false;
    // Exclude email from dirty checking since it's read-only
    const editableFields: (keyof FormData)[] = ['name', 'avatar', 'baseCurrencyId'];
    return editableFields.some((key) => formData[key] !== originalData[key]);
  }, [formData, originalData]);

  const setField = useCallback(<K extends keyof FormData>(key: K, value: FormData[K]) => {
    setFormData((prev) => (prev ? { ...prev, [key]: value } : prev));
  }, []);

  // Validation (basic inline) - email is read-only so no validation needed
  const validate = useCallback((data: FormData) => {
    const errors: Record<string, string> = {};
    const trimmedName = data.name.trim();
    if (trimmedName.length === 0) errors.name = 'Name cannot be empty';
    else if (trimmedName.length < 2) errors.name = 'Name must be at least 2 characters';
    else if (trimmedName.length > 100) errors.name = 'Name must not exceed 100 characters';
    else if (!/^[a-zA-Z0-9\s\-_'.&()]+$/.test(trimmedName))
      errors.name = 'Name contains invalid characters';

    // Email validation removed since it's read-only

    return errors;
  }, []);

  const handleSave = useCallback(async () => {
    if (!formData || !originalData) return;
    const errors = validate(formData);
    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const changed: Partial<FormData> = {};
    // Only check editable fields for changes (exclude email)
    const editableFields: (keyof FormData)[] = ['name', 'avatar', 'baseCurrencyId'];
    editableFields.forEach((k) => {
      if (formData[k] !== originalData[k]) {
        (changed as Record<string, unknown>)[k] = formData[k];
      }
    });
    if (Object.keys(changed).length === 0) return;

    setIsSaving(true);
    try {
      await updateUserPrefs.mutateAsync(
        changed as {
          name?: string;
          avatar?: string;
          baseCurrencyId?: string;
        }
      );
      // Update the original data so isDirty becomes false
      setOriginalData({ ...formData });
      toast({
        title: 'Settings Updated',
        description: 'Your preferences have been saved successfully.',
      });
    } catch (error: unknown) {
      toast({
        title: 'Update Failed',
        description: (error as Error)?.message ?? 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      // Allow reinitialization again after a short delay
      setTimeout(() => setIsSaving(false), 100);
    }
  }, [formData, originalData, updateUserPrefs, validate, toast]);

  const handleDiscard = useCallback(() => {
    if (originalData) {
      setFormData(originalData);
      setFormErrors({});
    }
  }, [originalData]);

  // Warn on unload with unsaved changes
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [isDirty]);

  // Cmd/Ctrl+S to save
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCmdS = (e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S');
      if (isCmdS) {
        e.preventDefault();
        if (isDirty) void handleSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isDirty, handleSave]);

  const handleExportData = async (format: 'json' | 'csv') => {
    try {
      // This would typically call an API endpoint to generate and download the export
      toast({
        title: 'Export Started',
        description: `Your data export in ${format.toUpperCase()} format has been queued. You'll receive a download link shortly.`,
      });
    } catch (_error) {
      toast({
        title: 'Export Failed',
        description: 'Failed to export your data. Please try again.',
        variant: 'destructive',
      });
    }
  };

  const handleDeleteAllData = async () => {
    const confirmed = await confirm({
      title: 'Delete All Data',
      description:
        'This will permanently delete all your financial data including institutions, accounts, holdings, and transactions. This action cannot be undone.',
      confirmText: 'Delete All Data',
      variant: 'danger',
      entityName: 'CONFIRM DELETE',
      entityType: 'all data',
    });

    if (confirmed) {
      try {
        // This would call the delete all data API
        toast({
          title: 'Data Deletion Started',
          description: 'All your data is being deleted. This may take a few moments.',
          variant: 'destructive',
        });
      } catch (_error) {
        toast({
          title: 'Deletion Failed',
          description: 'Failed to delete your data. Please contact support.',
          variant: 'destructive',
        });
      }
    }
  };

  const sections = [
    {
      id: 'general',
      title: 'General',
      icon: User,
      component: GeneralSettings,
    },
    {
      id: 'data',
      title: 'Data & Export',
      icon: FileText,
      component: DataSettings,
    },
    {
      id: 'help',
      title: 'Help & Support',
      icon: HelpCircle,
      component: HelpSettings,
    },
  ] as const;

  if (isLoading || !formData) {
    return (
      <div className="space-y-6">
        <PageHeader title="Settings" subtitle="Manage your account preferences" loading={true} />
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 bg-muted rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <PageHeader title="Settings" subtitle="Manage your account preferences" />
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={handleDiscard} disabled={!isDirty || isSaving}>
              Discard Changes
            </Button>
            <Button onClick={handleSave} disabled={!isDirty || isSaving}>
              {isSaving ? 'Saving…' : 'Save Changes'}
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* Navigation Sidebar */}
          <nav className="lg:col-span-1">
            <Card>
              <CardContent className="p-4">
                <div className="space-y-1">
                  {sections.map((section) => {
                    const Icon = section.icon;
                    return (
                      <button
                        key={section.id}
                        type="button"
                        onClick={() => setActiveSection(section.id)}
                        className={`w-full flex items-center space-x-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left ${
                          activeSection === section.id
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                        }`}
                      >
                        <Icon className="h-4 w-4" />
                        <span>{section.title}</span>
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          </nav>

          {/* Content Area */}
          <div className="lg:col-span-3">
            {activeSection === 'general' && (
              <GeneralSettings
                values={{
                  name: formData.name,
                  email: formData.email,
                  avatar: formData.avatar,
                  baseCurrencyId: formData.baseCurrencyId,
                }}
                errors={formErrors}
                onChange={(field, value) => setField(field, value)}
                supportedCurrencies={supportedCurrencies || []}
              />
            )}
            {activeSection === 'data' && (
              <DataSettings onExportData={handleExportData} onDeleteAllData={handleDeleteAllData} />
            )}
            {activeSection === 'help' && <HelpSettings />}
          </div>
        </div>
      </div>

      <ConfirmationComponent />
    </>
  );
}

// Settings Components
function GeneralSettings({
  values,
  errors,
  onChange,
  supportedCurrencies,
}: {
  values: {
    name: string;
    email: string;
    avatar: string;
    baseCurrencyId: string | '';
  };
  errors: Record<string, string>;
  onChange: (field: 'name' | 'avatar' | 'baseCurrencyId', value: string) => void;
  supportedCurrencies: Array<{ id: string; name: string; symbol: string }>;
}) {
  const displayNameId = useId();
  const emailId = useId();
  const avatarId = useId();
  const currencyId = useId();
  const [localErrors, setLocalErrors] = useState<Record<string, string>>({});

  const handleFieldChange = (field: 'name' | 'avatar' | 'baseCurrencyId', value: string) => {
    onChange(field, value);
    // simple inline validation feedback for name only
    const errors: Record<string, string> = {};
    if (field === 'name') {
      const trimmed = value.trim();
      if (trimmed.length === 0) errors.name = 'Name cannot be empty';
      else if (trimmed.length < 2) errors.name = 'Name must be at least 2 characters';
      else if (trimmed.length > 100) errors.name = 'Name must not exceed 100 characters';
      else if (!/^[a-zA-Z0-9\s\-_'.&()]+$/.test(trimmed))
        errors.name = 'Name contains invalid characters';
    }
    setLocalErrors((prev) => ({ ...prev, ...errors }));
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <User className="h-5 w-5" />
            <span>Profile Information</span>
          </CardTitle>
          <CardDescription>Manage your account profile and display preferences.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {errors.general && (
            <Alert variant="destructive">
              <AlertDescription>{errors.general}</AlertDescription>
            </Alert>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor={displayNameId}>Display Name *</Label>
              <div className="relative">
                <Input
                  id={displayNameId}
                  value={values.name}
                  onChange={(e) => handleFieldChange('name', e.target.value)}
                  placeholder="Your display name"
                  className={errors.name || localErrors.name ? 'border-destructive' : ''}
                />
              </div>
              {(errors.name || localErrors.name) && (
                <p className="text-sm text-destructive">{errors.name || localErrors.name}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor={emailId}>Email *</Label>
              <div className="relative">
                <Input
                  id={emailId}
                  type="email"
                  value={values.email}
                  readOnly
                  placeholder="your.email@example.com"
                  className="bg-muted cursor-not-allowed"
                  title="Email cannot be changed after account creation"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Email cannot be changed after account creation
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor={avatarId}>Avatar URL</Label>
              <Input
                id={avatarId}
                value={values.avatar}
                onChange={(e) => handleFieldChange('avatar', e.target.value)}
                placeholder="https://example.com/avatar.jpg"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={currencyId}>Base Currency</Label>
              <CurrencySelector
                id={currencyId}
                value={values.baseCurrencyId}
                onValueChange={(value) => handleFieldChange('baseCurrencyId', value)}
                currencies={supportedCurrencies}
                placeholder="Select currency..."
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function DataSettings({
  onExportData,
  onDeleteAllData,
}: {
  onExportData: (format: 'json' | 'csv') => void;
  onDeleteAllData: () => void;
}) {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Download className="h-5 w-5" />
            <span>Export Data</span>
          </CardTitle>
          <CardDescription>
            Download your financial data in various formats for backup or analysis.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <Button onClick={() => onExportData('json')} className="flex-1">
              <FileText className="h-4 w-4 mr-2" />
              Export as JSON
            </Button>
            <Button variant="outline" onClick={() => onExportData('csv')} className="flex-1">
              <FileText className="h-4 w-4 mr-2" />
              Export as CSV
            </Button>
          </div>
          <Alert>
            <AlertDescription>
              Exported data includes all your institutions, accounts, holdings, transactions, and
              preferences. Personal identifiers are excluded for privacy.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Upload className="h-5 w-5" />
            <span>Import Data</span>
          </CardTitle>
          <CardDescription>
            Import financial data from other applications or restore from backup.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button variant="outline">
            <Upload className="h-4 w-4 mr-2" />
            Choose File to Import
          </Button>
          <Alert>
            <AlertDescription>
              Supported formats: JSON, CSV. Importing will merge with existing data. Duplicates will
              be skipped.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Card className="border-destructive">
        <CardHeader>
          <CardTitle className="flex items-center space-x-2 text-destructive">
            <Trash2 className="h-5 w-5" />
            <span>Danger Zone</span>
          </CardTitle>
          <CardDescription>
            Irreversible actions that permanently modify or delete your data.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="destructive" onClick={onDeleteAllData}>
            <Trash2 className="h-4 w-4 mr-2" />
            Delete All Data
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

function HelpSettings() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <HelpCircle className="h-5 w-5" />
            <span>Help & Support</span>
          </CardTitle>
          <CardDescription>Get help, report issues, and access documentation.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Button variant="outline" className="justify-start h-auto p-4">
              <div className="text-left">
                <h4 className="font-medium">Documentation</h4>
                <p className="text-sm text-muted-foreground">User guide and API documentation</p>
              </div>
            </Button>
            <Button variant="outline" className="justify-start h-auto p-4">
              <div className="text-left">
                <h4 className="font-medium">Contact Support</h4>
                <p className="text-sm text-muted-foreground">Get help from our support team</p>
              </div>
            </Button>
            <Button variant="outline" className="justify-start h-auto p-4">
              <div className="text-left">
                <h4 className="font-medium">Feature Requests</h4>
                <p className="text-sm text-muted-foreground">
                  Suggest new features and improvements
                </p>
              </div>
            </Button>
            <Button variant="outline" className="justify-start h-auto p-4">
              <div className="text-left">
                <h4 className="font-medium">Report a Bug</h4>
                <p className="text-sm text-muted-foreground">Help us fix issues you encounter</p>
              </div>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>About Scani</CardTitle>
          <CardDescription>Application information and version details.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex justify-between">
            <span className="text-sm font-medium">Version</span>
            <span className="text-sm text-muted-foreground">1.0.0</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm font-medium">Last Updated</span>
            <span className="text-sm text-muted-foreground">{new Date().toLocaleDateString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm font-medium">Environment</span>
            <span className="text-sm text-muted-foreground">Development</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
