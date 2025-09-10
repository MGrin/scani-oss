import {
  type Account,
  FinancialMath,
  type Holding,
  type Institution,
  type Token,
} from '@scani/shared';
import {
  Building,
  Coins,
  CreditCard,
  DollarSign,
  Edit2,
  Eye,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import { useState } from 'react';
import { HoldingForm } from '@/components/HoldingForm';
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
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { BUTTON_TEXT } from '@/lib/button-constants';
import { trpc } from '@/lib/trpc';

type SortBy = 'balance' | 'token' | 'account' | 'type';
type FilterBy = 'all' | 'fiat' | 'crypto' | 'stock' | 'etf' | 'bond' | 'commodity' | 'other';

interface ProcessedHolding extends Holding {
  token: Token;
  account: Account;
  institution: Institution | null;
  value: number;
}

export function Holdings() {
  const { data: holdings, isLoading: holdingsLoading } = trpc.holdings.getAll.useQuery();
  const { data: accounts } = trpc.accounts.getAll.useQuery();
  const { data: tokens } = trpc.tokens.getAll.useQuery();
  const { data: institutions } = trpc.institutions.getAll.useQuery();

  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<SortBy>('balance');
  const [filterBy, setFilterBy] = useState<FilterBy>('all');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [isHoldingFormOpen, setIsHoldingFormOpen] = useState(false);
  const [holdingToEdit, setHoldingToEdit] = useState<Holding | undefined>();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [holdingToDelete, setHoldingToDelete] = useState<ProcessedHolding | undefined>();
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [holdingToView, setHoldingToView] = useState<ProcessedHolding | undefined>();

  const utils = trpc.useUtils();
  const { toast } = useToast();

  const deleteHolding = trpc.holdings.delete.useMutation({
    onSuccess: () => {
      toast({
        title: 'Success',
        description: `Holding for "${holdingToDelete?.token?.symbol || 'token'}" has been deleted successfully.`,
        variant: 'success',
      });
      utils.holdings.getAll.invalidate();
      setIsDeleteDialogOpen(false);
      setHoldingToDelete(undefined);
    },
    onError: (error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to delete holding. Please try again.',
        variant: 'destructive',
      });
    },
  });

  // Create maps for quick lookups
  const tokensMap = tokens ? Object.fromEntries(tokens.map((token) => [token.id, token])) : {};
  const accountsMap = accounts
    ? Object.fromEntries(accounts.map((account) => [account.id, account]))
    : {};
  const institutionsMap = institutions
    ? Object.fromEntries(institutions.map((inst) => [inst.id, inst]))
    : {};

  // Process holdings data
  const processedHoldings =
    holdings?.map((holding) => ({
      ...holding,
      token: tokensMap[holding.tokenId],
      account: accountsMap[holding.accountId],
      institution: (() => {
        const account = holding.accountId ? accountsMap[holding.accountId] : null;
        const institutionId = account?.institutionId;
        return institutionId ? institutionsMap[institutionId] || null : null;
      })(),
      value: FinancialMath.toNumber(FinancialMath.abs(holding.balance)),
    })) || [];

  // Apply filters and search
  const filteredHoldings = processedHoldings.filter((holding) => {
    const matchesSearch =
      !searchTerm ||
      holding.token?.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      holding.token?.symbol.toLowerCase().includes(searchTerm.toLowerCase()) ||
      holding.account?.name.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesFilter = filterBy === 'all' || holding.token?.type === filterBy;

    return matchesSearch && matchesFilter;
  });

  // Apply sorting
  const sortedHoldings = [...filteredHoldings].sort((a, b) => {
    let aValue: string | number, bValue: string | number;

    switch (sortBy) {
      case 'balance':
        aValue = a.value;
        bValue = b.value;
        break;
      case 'token':
        aValue = a.token?.symbol || '';
        bValue = b.token?.symbol || '';
        break;
      case 'account':
        aValue = a.account?.name || '';
        bValue = b.account?.name || '';
        break;
      case 'type':
        aValue = a.token?.type || '';
        bValue = b.token?.type || '';
        break;
      default:
        aValue = a.value;
        bValue = b.value;
    }

    if (typeof aValue === 'string') {
      return sortDirection === 'asc'
        ? aValue.localeCompare(String(bValue))
        : String(bValue).localeCompare(aValue);
    } else {
      return sortDirection === 'asc'
        ? Number(aValue) - Number(bValue)
        : Number(bValue) - Number(aValue);
    }
  });

  const handleSort = (newSortBy: SortBy) => {
    if (sortBy === newSortBy) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(newSortBy);
      setSortDirection('desc');
    }
  };

  const handleAddHolding = () => {
    setHoldingToEdit(undefined);
    setIsHoldingFormOpen(true);
  };

  const handleEditHolding = (holding: ProcessedHolding) => {
    setHoldingToEdit({
      id: holding.id,
      accountId: holding.accountId,
      tokenId: holding.tokenId,
      balance: holding.balance,
      averageCostBasis: holding.averageCostBasis,
      lastUpdated: holding.lastUpdated,
      createdAt: holding.createdAt,
    });
    setIsHoldingFormOpen(true);
  };

  const handleDeleteHolding = (holding: ProcessedHolding) => {
    setHoldingToDelete(holding);
    setIsDeleteDialogOpen(true);
  };

  const handleViewHolding = (holding: ProcessedHolding) => {
    setHoldingToView(holding);
    setIsViewDialogOpen(true);
  };

  const confirmDeleteHolding = () => {
    if (holdingToDelete) {
      deleteHolding.mutate({ id: holdingToDelete.id });
    }
  };

  const getTokenTypeIcon = (type: string) => {
    switch (type) {
      case 'fiat':
        return DollarSign;
      case 'crypto':
        return Coins;
      case 'stock':
        return TrendingUp;
      case 'etf':
        return Building;
      default:
        return CreditCard;
    }
  };

  const totalValue = processedHoldings.reduce((sum, holding) => sum + holding.value, 0);
  const filteredValue = sortedHoldings.reduce((sum, holding) => sum + holding.value, 0);

  if (holdingsLoading || !tokens || !accounts || !institutions) {
    return (
      <div className="space-y-4">
        <PageHeader title="Holdings" subtitle="Manage your investment positions" loading={true} />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <div className="animate-pulse space-y-4">
                  <div className="h-4 bg-muted rounded w-32"></div>
                  <div className="h-6 bg-muted rounded w-24"></div>
                  <div className="h-3 bg-muted rounded w-20"></div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Holdings"
        subtitle="Manage your investment positions"
        primaryAction={{
          label: BUTTON_TEXT.CREATE_HOLDING,
          onClick: handleAddHolding,
          icon: <Plus className="h-4 w-4 mr-1" />,
        }}
      />

      {/* Summary Stats */}
      <div className="grid gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium">Total Holdings</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-lg font-bold">{processedHoldings.length}</div>
            <p className="text-xs text-muted-foreground">Across {accounts?.length || 0} accounts</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium">Total Value</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-lg font-bold">{FinancialMath.formatCurrency(totalValue)}</div>
            <p className="text-xs text-muted-foreground">All holdings combined</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium">Filtered Results</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-lg font-bold">{sortedHoldings.length}</div>
            <p className="text-xs text-muted-foreground">
              {FinancialMath.formatCurrency(filteredValue)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-xs font-medium">Token Types</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="text-lg font-bold">
              {[...new Set(processedHoldings.map((h) => h.token?.type))].filter(Boolean).length}
            </div>
            <p className="text-xs text-muted-foreground">Asset categories</p>
          </CardContent>
        </Card>
      </div>

      {/* Search and Filter */}
      {processedHoldings && processedHoldings.length > 0 && (
        <Card>
          <CardContent className="p-3">
            <div className="space-y-3">
              <div className="flex flex-col sm:flex-row gap-3">
                {/* Search */}
                <div className="flex-1">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search holdings, tokens, or accounts..."
                      className="pl-10 h-9 text-sm"
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                    />
                  </div>
                </div>

                {/* Filter by token type */}
                <Select value={filterBy} onValueChange={(value) => setFilterBy(value as FilterBy)}>
                  <SelectTrigger className="w-[140px] h-9">
                    <SelectValue placeholder="Filter by type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value="fiat">Fiat</SelectItem>
                    <SelectItem value="crypto">Crypto</SelectItem>
                    <SelectItem value="stock">Stocks</SelectItem>
                    <SelectItem value="etf">ETFs</SelectItem>
                    <SelectItem value="bond">Bonds</SelectItem>
                    <SelectItem value="commodity">Commodities</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Sort Controls */}
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">Sort by:</span>
                {[
                  { key: 'balance' as const, label: 'Balance' },
                  { key: 'token' as const, label: 'Token' },
                  { key: 'account' as const, label: 'Account' },
                  { key: 'type' as const, label: 'Type' },
                ].map((option) => (
                  <Button
                    key={option.key}
                    variant={sortBy === option.key ? 'default' : 'ghost'}
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => handleSort(option.key)}
                  >
                    {option.label}
                    {sortBy === option.key && (
                      <span className="ml-1">{sortDirection === 'asc' ? '↑' : '↓'}</span>
                    )}
                  </Button>
                ))}
              </div>
              {(searchTerm || filterBy !== 'all') && (
                <p className="text-xs text-muted-foreground">
                  {sortedHoldings.length} of {processedHoldings.length} holdings match your criteria
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Holdings List */}
      {!processedHoldings || processedHoldings.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Coins className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <div className="text-muted-foreground mb-4">No holdings found</div>
            <Button onClick={handleAddHolding}>
              <Plus className="h-4 w-4 mr-2" />
              {BUTTON_TEXT.ADD_FIRST_HOLDING}
            </Button>
          </CardContent>
        </Card>
      ) : sortedHoldings.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <div className="text-muted-foreground mb-4">No holdings match your search criteria</div>
            <Button
              onClick={() => {
                setSearchTerm('');
                setFilterBy('all');
              }}
            >
              Clear Filters
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sortedHoldings.map((holding) => {
            const TypeIcon = getTokenTypeIcon(holding.token?.type || 'other');

            return (
              <Card key={holding.id} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                        <div className="text-center">
                          <div className="text-xs font-medium">{holding.token?.symbol || '?'}</div>
                          <TypeIcon className="h-2.5 w-2.5 mx-auto mt-0.5" />
                        </div>
                      </div>
                      <div>
                        <div className="flex items-center space-x-2">
                          <p className="font-medium text-sm">
                            {holding.token?.name || 'Unknown Token'}
                          </p>
                          <span className="text-xs px-1.5 py-0.5 bg-muted rounded capitalize">
                            {holding.token?.type || 'unknown'}
                          </span>
                        </div>
                        <div className="flex items-center space-x-1 text-xs text-muted-foreground">
                          <span>{holding.account?.name || 'Unknown Account'}</span>
                          <span>•</span>
                          <span>{holding.institution?.name || 'Unknown Institution'}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center space-x-3">
                      <div className="text-right">
                        <p className="font-semibold text-base">
                          {FinancialMath.formatCurrency(holding.value)}
                        </p>
                        <div className="text-xs text-muted-foreground">
                          {holding.balance.toFixed(holding.token?.decimals || 2)}{' '}
                          {holding.token?.symbol}
                          {holding.averageCostBasis && (
                            <span className="ml-2">@ ${holding.averageCostBasis.toFixed(2)}</span>
                          )}
                        </div>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() =>
                              handleViewHolding(holding as unknown as ProcessedHolding)
                            }
                          >
                            <Eye className="h-4 w-4 mr-2" />
                            View Details
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              handleEditHolding(holding as unknown as ProcessedHolding)
                            }
                          >
                            <Edit2 className="h-4 w-4 mr-2" />
                            {BUTTON_TEXT.EDIT_HOLDING}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              handleDeleteHolding(holding as unknown as ProcessedHolding)
                            }
                            className="text-destructive"
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            {BUTTON_TEXT.DELETE_HOLDING}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="text-xs text-muted-foreground">
                    Updated {new Date(holding.lastUpdated).toLocaleDateString()}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Holding Form Dialog */}
      <HoldingForm
        isOpen={isHoldingFormOpen}
        onClose={() => setIsHoldingFormOpen(false)}
        holding={holdingToEdit}
        mode={holdingToEdit ? 'edit' : 'create'}
      />

      {/* View Holding Details Dialog */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Holding Details</DialogTitle>
            <DialogDescription>Complete information about this holding</DialogDescription>
          </DialogHeader>
          {holdingToView && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Token</p>
                  <p className="font-semibold">
                    {holdingToView.token?.name} ({holdingToView.token?.symbol})
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {holdingToView.token?.type}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Current Value</p>
                  <p className="font-semibold text-lg">
                    {FinancialMath.formatCurrency(holdingToView.value)}
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Balance</p>
                  <p className="font-semibold">
                    {(holdingToView.balance || 0).toFixed(holdingToView.token?.decimals || 2)}{' '}
                    {holdingToView.token?.symbol}
                  </p>
                </div>
                {holdingToView.averageCostBasis && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Avg Cost Basis</p>
                    <p className="font-semibold">${holdingToView.averageCostBasis.toFixed(2)}</p>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Account</p>
                  <p className="font-semibold">{holdingToView.account?.name}</p>
                  <p className="text-xs text-muted-foreground">{holdingToView.institution?.name}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Last Updated</p>
                  <p className="font-semibold">
                    {new Date(holdingToView.lastUpdated).toLocaleDateString()}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(holdingToView.lastUpdated).toLocaleTimeString()}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Created</p>
                <p className="font-semibold">
                  {new Date(holdingToView.createdAt).toLocaleDateString()}
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setIsViewDialogOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Holding</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this holding for "{holdingToDelete?.token?.name}"?
              This action cannot be undone and will permanently remove the holding record and all
              associated transactions.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
              disabled={deleteHolding.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteHolding}
              disabled={deleteHolding.isPending}
            >
              {deleteHolding.isPending ? 'Deleting...' : BUTTON_TEXT.DELETE_HOLDING}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
