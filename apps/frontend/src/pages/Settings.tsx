import { User } from 'lucide-react';
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
import { withOptimisticHandlers } from '@/lib/cache/optimistic/entityManager';
import { trpc } from '@/lib/trpc';

export function Settings() {
  const { toast } = useToast();
  const { ConfirmationComponent } = useConfirmation();

  // Data fetching
  const { data: userPrefs, isLoading } = trpc.users.getCurrent.useQuery();
  const { data: supportedCurrencies } = trpc.users.getSupportedCurrencies.useQuery();
  const utils = trpc.useUtils();
  const updateUserPrefs = trpc.users.updateCurrent.useMutation(
    withOptimisticHandlers('user', 'update', utils)
  );

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

        {/* Content Area */}
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
