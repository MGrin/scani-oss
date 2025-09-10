import type { Institution } from '@scani/shared';
import { AlertTriangle, Building2, Edit2, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { InstitutionForm } from '@/components/InstitutionForm';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LoadingSpinner } from '@/components/ui/loading';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/hooks/use-toast';
import { BUTTON_TEXT } from '@/lib/button-constants';
import { MOBILE_SPACING } from '@/lib/mobile-utils';
import { trpc } from '@/lib/trpc';

export function Institutions() {
  const [isInstitutionFormOpen, setIsInstitutionFormOpen] = useState(false);
  const [institutionToEdit, setInstitutionToEdit] = useState<Institution | undefined>();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [institutionToDelete, setInstitutionToDelete] = useState<Institution | undefined>();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { toast } = useToast();
  const { data: institutions, isLoading } = trpc.institutions.getAll.useQuery();
  const { data: institutionTypes } = trpc.institutionTypes.getAll.useQuery();
  const utils = trpc.useUtils();

  // Query linked accounts for the institution to be deleted
  const { data: linkedAccounts } = trpc.accounts.getByInstitutionId.useQuery(
    { institutionId: institutionToDelete?.id || '' },
    { enabled: !!institutionToDelete?.id }
  );

  const deleteInstitution = trpc.institutions.delete.useMutation({
    onSuccess: () => {
      toast({
        title: 'Success',
        description: `Institution "${institutionToDelete?.name}" has been deleted successfully.`,
        variant: 'success',
      });
      utils.institutions.getAll.invalidate();
      setIsDeleteDialogOpen(false);
      setInstitutionToDelete(undefined);
      setDeleteError(null);
    },
    onError: (error) => {
      setDeleteError(error.message);
      toast({
        title: 'Error',
        description: error.message || 'Failed to delete institution. Please try again.',
        variant: 'destructive',
      });
    },
  });

  const handleAddInstitution = () => {
    setInstitutionToEdit(undefined);
    setIsInstitutionFormOpen(true);
  };

  const handleEditInstitution = (institution: Institution) => {
    setInstitutionToEdit(institution);
    setIsInstitutionFormOpen(true);
  };

  const handleDeleteInstitution = (institution: Institution) => {
    setInstitutionToDelete(institution);
    setIsDeleteDialogOpen(true);
  };

  const confirmDeleteInstitution = () => {
    if (institutionToDelete) {
      deleteInstitution.mutate({ id: institutionToDelete.id });
    }
  };

  const getInstitutionTypeLabel = (type: string) => {
    const institutionType = institutionTypes?.find((t) => t.code === type);
    return institutionType?.name || type;
  };

  const getInstitutionTypeColor = (type: string) => {
    // Default color mapping - this could be moved to backend later if needed
    const typeColors: Record<string, string> = {
      bank: '#3b82f6',
      broker: '#8b5cf6',
      crypto_exchange: '#f59e0b',
      crypto_wallet: '#10b981',
      other: '#6b7280',
    };
    return typeColors[type] || '#6b7280';
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Institutions"
          subtitle="Manage your financial institutions"
          loading={true}
        />
        <div className="flex items-center justify-center py-12">
          <div className="flex flex-col items-center gap-3">
            <LoadingSpinner size="lg" />
            <p className="text-muted-foreground">Loading institutions...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={MOBILE_SPACING.sectionGap}>
      <PageHeader
        title="Institutions"
        subtitle="Manage your financial institutions"
        primaryAction={{
          label: BUTTON_TEXT.CREATE_INSTITUTION,
          onClick: handleAddInstitution,
          icon: <Plus className="h-4 w-4 mr-1" />,
        }}
      />

      {!institutions || institutions.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Building2 className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <div className="text-muted-foreground mb-4">No institutions found</div>
            <Button onClick={handleAddInstitution}>
              <Plus className="h-4 w-4 mr-2" />
              {BUTTON_TEXT.ADD_FIRST_INSTITUTION}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className={`grid ${MOBILE_SPACING.gridGap} md:grid-cols-2 lg:grid-cols-3`}>
          {institutions.map((institution) => (
            <Card key={institution.id} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{
                        backgroundColor: getInstitutionTypeColor(institution.type || 'other'),
                      }}
                    />
                    <CardTitle
                      className="text-base truncate max-w-[200px]"
                      title={institution.name}
                    >
                      {institution.name}
                    </CardTitle>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => handleEditInstitution(institution as unknown as Institution)}
                      >
                        <Edit2 className="h-4 w-4 mr-2" />
                        {BUTTON_TEXT.EDIT_INSTITUTION}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          handleDeleteInstitution(institution as unknown as Institution)
                        }
                        className="text-destructive"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        {BUTTON_TEXT.DELETE_INSTITUTION}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="space-y-2">
                  <div>
                    <p className="text-xs text-muted-foreground">Type</p>
                    <p className="text-sm font-medium">
                      {getInstitutionTypeLabel(institution.type || 'other')}
                    </p>
                  </div>
                  {institution.description && (
                    <div>
                      <p className="text-xs text-muted-foreground">Description</p>
                      <p className="text-sm truncate" title={institution.description}>
                        {institution.description}
                      </p>
                    </div>
                  )}
                  {institution.website && (
                    <div>
                      <p className="text-xs text-muted-foreground">Website</p>
                      <a
                        href={institution.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm text-blue-600 hover:underline truncate block"
                        title={institution.website}
                      >
                        {institution.website}
                      </a>
                    </div>
                  )}
                  <div className="pt-1 border-t">
                    <p className="text-xs text-muted-foreground">
                      Created {new Date(institution.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Institution Form Dialog */}
      <InstitutionForm
        isOpen={isInstitutionFormOpen}
        onClose={() => setIsInstitutionFormOpen(false)}
        institution={institutionToEdit}
        mode={institutionToEdit ? 'edit' : 'create'}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-orange-500" />
              Delete Institution
            </DialogTitle>
            <DialogDescription className="space-y-3">
              <p>
                Are you sure you want to delete <strong>"{institutionToDelete?.name}"</strong>?
              </p>
              <p className="text-sm text-muted-foreground">This action cannot be undone.</p>

              {linkedAccounts && linkedAccounts.length > 0 ? (
                <div className="p-3 border rounded-md bg-orange-50 dark:bg-orange-950/20">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 text-orange-500 mt-0.5 flex-shrink-0" />
                    <div className="text-sm">
                      <p className="font-medium text-orange-800 dark:text-orange-200 mb-1">
                        Warning: This institution has {linkedAccounts.length} linked account
                        {linkedAccounts.length !== 1 ? 's' : ''}:
                      </p>
                      <ul className="list-disc list-inside space-y-1 text-orange-700 dark:text-orange-300">
                        {linkedAccounts.slice(0, 3).map((account) => (
                          <li key={account.id} className="truncate">
                            {account.name} (
                            {account.type.charAt(0).toUpperCase() + account.type.slice(1)})
                          </li>
                        ))}
                        {linkedAccounts.length > 3 && (
                          <li>...and {linkedAccounts.length - 3} more</li>
                        )}
                      </ul>
                      <p className="mt-2 text-xs text-orange-600 dark:text-orange-400">
                        Please reassign or delete these accounts before deleting the institution.
                      </p>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-green-600 dark:text-green-400">
                  This institution has no linked accounts and can be safely deleted.
                </p>
              )}

              {deleteError && (
                <div className="p-3 border rounded-md bg-red-50 dark:bg-red-950/20">
                  <p className="text-sm text-red-600 dark:text-red-400">{deleteError}</p>
                </div>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsDeleteDialogOpen(false);
                setDeleteError(null);
              }}
              disabled={deleteInstitution.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteInstitution}
              disabled={
                deleteInstitution.isPending || (linkedAccounts && linkedAccounts.length > 0)
              }
            >
              {deleteInstitution.isPending ? 'Deleting...' : 'Delete Institution'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
