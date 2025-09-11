import { zodResolver } from '@hookform/resolvers/zod';
import { type Institution, InstitutionType } from '@scani/shared';
import React, { useCallback, useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { LoadingButton } from '@/components/ui/loading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

// Enhanced validation schema with stricter validation
const InstitutionFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Institution name is required')
    .max(50, 'Institution name must be at most 50 characters')
    .regex(/^[\x20-\x7E]+$/, 'Name must contain printable ASCII characters only'),
  type: InstitutionType,
  description: z
    .string()
    .max(300, 'Description must be at most 300 characters')
    .optional()
    .or(z.literal('')),
  website: z
    .string()
    .max(100, 'Website URL must be at most 100 characters')
    .url('Please enter a valid URL starting with http:// or https://')
    .optional()
    .or(z.literal('')),
});

type InstitutionFormData = z.infer<typeof InstitutionFormSchema>;

interface InstitutionFormProps {
  isOpen: boolean;
  onClose: () => void;
  institution?: Institution;
  mode: 'create' | 'edit';
}

export function InstitutionForm({ isOpen, onClose, institution, mode }: InstitutionFormProps) {
  const { toast } = useToast();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showUnsavedWarning, setShowUnsavedWarning] = useState(false);
  const nameId = useId();
  const websiteId = useId();
  const descriptionId = useId();

  const utils = trpc.useUtils();

  // Fetch institution types from backend
  const {
    data: institutionTypes,
    isLoading: isLoadingTypes,
    error: institutionTypesError,
  } = trpc.institutionTypes.getAll.useQuery();

  const createInstitution = trpc.institutions.create.useMutation({
    onSuccess: (data) => {
      toast({
        title: 'Success',
        description: `Institution "${
          data?.name || 'New institution'
        }" has been created successfully.`,
        variant: 'success',
      });
      utils.institutions.getAll.invalidate();
      handleSuccessfulClose();
    },
    onError: (error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to create institution. Please try again.',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setIsSubmitting(false);
    },
  });

  const updateInstitution = trpc.institutions.update.useMutation({
    onSuccess: (data) => {
      toast({
        title: 'Success',
        description: `Institution "${data?.name || 'Institution'}" has been updated successfully.`,
        variant: 'success',
      });
      utils.institutions.getAll.invalidate();
      handleSuccessfulClose();
    },
    onError: (error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to update institution. Please try again.',
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setIsSubmitting(false);
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isDirty },
    setValue,
    watch,
    reset,
    setError,
  } = useForm<InstitutionFormData>({
    resolver: zodResolver(InstitutionFormSchema),
    defaultValues: {
      name: institution?.name || '',
      type:
        (institution?.type as z.infer<typeof InstitutionType>) ||
        (institutionTypes?.[0]?.code as z.infer<typeof InstitutionType>) ||
        'bank',
      description: institution?.description || '',
      website: institution?.website || '',
    },
    mode: 'onSubmit',
  });

  // Reset form when institution or institution types change
  React.useEffect(() => {
    if (institution) {
      reset({
        name: institution.name,
        type: institution.type as z.infer<typeof InstitutionType>,
        description: institution.description || '',
        website: institution.website || '',
      });
    } else {
      reset({
        name: '',
        type: (institutionTypes?.[0]?.code as z.infer<typeof InstitutionType>) || 'bank',
        description: '',
        website: '',
      });
    }
  }, [institution, institutionTypes, reset]);

  const watchedType = watch('type');
  const watchedName = watch('name');
  const watchedDescription = watch('description');
  const watchedWebsite = watch('website');

  // Helper functions
  const handleSuccessfulClose = useCallback(() => {
    reset();
    setShowUnsavedWarning(false);
    onClose();
  }, [reset, onClose]);

  const handleCancelWithWarning = useCallback(() => {
    if (isDirty) {
      setShowUnsavedWarning(true);
    } else {
      handleSuccessfulClose();
    }
  }, [isDirty, handleSuccessfulClose]);

  const confirmUnsavedClose = useCallback(() => {
    setShowUnsavedWarning(false);
    handleSuccessfulClose();
  }, [handleSuccessfulClose]);

  const cancelUnsavedClose = useCallback(() => {
    setShowUnsavedWarning(false);
  }, []);

  // Submit validation - comprehensive check before submission
  const onSubmit = async (data: InstitutionFormData) => {
    // Check for basic form validation errors
    const hasFormErrors = Object.keys(errors).length > 0;

    if (hasFormErrors) {
      toast({
        title: 'Validation Error',
        description: 'Please fix the errors below and try again.',
        variant: 'destructive',
      });
      return;
    }

    // Prevent submission if institution types failed to load
    if (institutionTypesError) {
      toast({
        title: 'Error',
        description:
          'Institution types could not be loaded. Please refresh the page and try again.',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);

    // Check name uniqueness only on submission
    try {
      const nameCheckResult = await utils.client.institutions.checkNameUniqueness.query({
        name: data.name.trim(),
        excludeId: mode === 'edit' ? institution?.id : undefined,
      });

      if (!nameCheckResult.isUnique) {
        setError('name', {
          type: 'manual',
          message: 'An institution with this name already exists. Please choose a different name.',
        });
        toast({
          title: 'Name Already Exists',
          description:
            'An institution with this name already exists. Please choose a different name.',
          variant: 'destructive',
        });
        setIsSubmitting(false);
        return;
      }
    } catch (error) {
      console.warn('Name uniqueness check failed:', error);
      toast({
        title: 'Validation Error',
        description: 'Unable to validate institution name. Please try again.',
        variant: 'destructive',
      });
      setIsSubmitting(false);
      return;
    }

    if (mode === 'create') {
      createInstitution.mutate({
        name: data.name.trim(),
        type: data.type,
        description: data.description?.trim() || undefined,
        website: data.website?.trim() || undefined,
      });
    } else if (institution) {
      updateInstitution.mutate({
        id: institution.id,
        data: {
          name: data.name.trim(),
          type: data.type,
          description: data.description?.trim() || undefined,
          website: data.website?.trim() || undefined,
        },
      });
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      handleCancelWithWarning();
    }
  };

  const institutionTypeOptions =
    institutionTypes?.map(
      (type: {
        code: string;
        name: string;
        id: string;
        description: string | null;
        displayOrder: number;
      }) => ({
        value: type.code,
        label: type.name,
      })
    ) || [];

  // Show error if backend fails to return institution types
  if (institutionTypesError) {
    console.error('Failed to load institution types from backend:', institutionTypesError);
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {mode === 'create' ? 'Add New Institution' : 'Edit Institution'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Create a new financial institution to organize your accounts.'
              : 'Update the details of your financial institution.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {/* Institution Name */}
          <div className="space-y-2">
            <Label htmlFor={nameId}>
              Institution Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id={nameId}
              {...register('name')}
              placeholder="e.g., Chase Bank, Fidelity Investments"
              maxLength={50}
              disabled={isSubmitting}
              className={errors.name ? 'border-destructive focus:border-destructive' : ''}
            />
            <div className="flex justify-between items-start">
              <div className="flex-1 min-h-[20px]">
                {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
              </div>
              <div className="text-xs text-muted-foreground ml-2">
                <span className={watchedName && watchedName.length > 45 ? 'text-orange-600' : ''}>
                  {watchedName?.length || 0}/50
                </span>
              </div>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="type">Institution Type *</Label>
            <Select
              value={watchedType}
              onValueChange={(value) => setValue('type', value as z.infer<typeof InstitutionType>)}
              disabled={isSubmitting || isLoadingTypes}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={isLoadingTypes ? 'Loading types...' : 'Select institution type'}
                />
              </SelectTrigger>
              <SelectContent>
                {isLoadingTypes ? (
                  <SelectItem value="loading" disabled>
                    Loading institution types...
                  </SelectItem>
                ) : institutionTypesError ? (
                  <SelectItem value="error" disabled>
                    Error loading institution types
                  </SelectItem>
                ) : (
                  institutionTypeOptions.map((option: { value: string; label: string }) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            {errors.type && <p className="text-sm text-destructive">{errors.type.message}</p>}
          </div>

          {/* Website (Optional) */}
          <div className="space-y-2">
            <Label htmlFor={websiteId}>Website (Optional)</Label>
            <Input
              id={websiteId}
              {...register('website')}
              placeholder="e.g., https://www.chase.com"
              type="url"
              maxLength={100}
              disabled={isSubmitting}
              className={errors.website ? 'border-destructive focus:border-destructive' : ''}
            />
            <div className="flex justify-between items-start">
              <div className="flex-1 min-h-[20px]">
                {errors.website && (
                  <p className="text-sm text-destructive">{errors.website.message}</p>
                )}
                {!errors.website && watchedWebsite && (
                  <p className="text-xs text-muted-foreground">
                    Enter a valid URL starting with http:// or https://
                  </p>
                )}
              </div>
              <div className="text-xs text-muted-foreground ml-2">
                <span
                  className={watchedWebsite && watchedWebsite.length > 90 ? 'text-orange-600' : ''}
                >
                  {watchedWebsite?.length || 0}/100
                </span>
              </div>
            </div>
          </div>

          {/* Description (Optional) */}
          <div className="space-y-2">
            <Label htmlFor={descriptionId}>Description (Optional)</Label>
            <Textarea
              id={descriptionId}
              {...register('description')}
              placeholder="Additional details about this institution..."
              rows={3}
              maxLength={300}
              disabled={isSubmitting}
              className={errors.description ? 'border-destructive focus:border-destructive' : ''}
            />
            <div className="flex justify-between items-start">
              <div className="flex-1 min-h-[20px]">
                {errors.description && (
                  <p className="text-sm text-destructive">{errors.description.message}</p>
                )}
              </div>
              <div className="text-xs text-muted-foreground ml-2">
                <span
                  className={
                    watchedDescription && watchedDescription.length > 280 ? 'text-orange-600' : ''
                  }
                >
                  {watchedDescription?.length || 0}/300
                </span>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleCancelWithWarning}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              <LoadingButton
                isLoading={isSubmitting}
                loadingText={mode === 'create' ? 'Creating...' : 'Updating...'}
              >
                {mode === 'create' ? 'Create Institution' : 'Update Institution'}
              </LoadingButton>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>

      {/* Unsaved Changes Warning Dialog */}
      <Dialog open={showUnsavedWarning} onOpenChange={() => setShowUnsavedWarning(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Unsaved Changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes. Are you sure you want to close without saving?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={cancelUnsavedClose}>
              Keep Editing
            </Button>
            <Button variant="destructive" onClick={confirmUnsavedClose}>
              Discard Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
