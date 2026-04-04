import type { HoldingWithDetails } from '@scani/shared';
import { AlertTriangle, Download, Filter, PieChart } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BulkActionBar, HoldingActionsMenu } from '@/components/holdings/HoldingActions';
import { HoldingCard } from '@/components/holdings/HoldingCard';
import { HoldingsLoadingSkeleton } from '@/components/holdings/HoldingsLoadingSkeleton';
import { HoldingsToolbar } from '@/components/holdings/HoldingsToolbar';
import { HoldingsTable } from '@/components/holdings/HoldingTableRow';
import { BulkEditGroupsModal } from '@/components/modals/BulkEditGroupsModal';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MoneyDisplay } from '@/components/ui/money-display';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { useFilters, useViewMode } from '@/hooks';
import { useToast } from '@/hooks/use-toast';
import { type GroupBy, useHoldingFilters } from '@/hooks/useHoldingFilters';
import { useHoldingsMutations } from '@/hooks/useHoldingsMutations';
import { exportHoldingsData } from '@/lib/export-holdings';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

export function Holdings() {
  const { data: holdingsData, isLoading, error } = trpc.holdings.getWithDetails.useQuery();
  const { data: groupsData } = trpc.groups.getAll.useQuery();
  const groups = groupsData || [];
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const currency = baseCurrency?.symbol || 'USD';
  const baseCurrencyToken = createCurrencyToken(currency);

  const { toast } = useToast();
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const holdings = holdingsData?.holdings || [];
  const holdingsSummary = holdingsData?.summary;

  const [searchTerm, setSearchTerm] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [viewMode, setViewMode] = useViewMode('cards');
  const [sortField, setSortField] = useState('value');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [valueRange, setValueRange] = useState('all');
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [bulkEditGroupsModalOpen, setBulkEditGroupsModalOpen] = useState(false);

  const {
    filters: filterValues,
    updateFilter,
    clearAllFilters,
  } = useFilters([
    { key: 'type', defaultValue: '' },
    { key: 'account', defaultValue: '' },
    { key: 'token', defaultValue: '' },
    { key: 'group', defaultValue: '' },
  ]);

  const filterBy = filterValues.type || '';
  const filterByAccount = filterValues.account || '';
  const filterByToken = filterValues.token || '';
  const filterByGroup = filterValues.group || '';

  const { filteredAndSortedHoldings, groupedHoldings, summaryStats, filterOptions } =
    useHoldingFilters({
      holdings,
      searchTerm,
      filterBy,
      filterByAccount,
      filterByToken,
      filterByGroup,
      valueRange,
      sortField,
      sortDirection,
      groupBy,
      holdingsSummary,
    });

  const { bulkDeleteHoldingsMutation, handleDeleteHolding, handleToggleActive, handleBulkDelete } =
    useHoldingsMutations(setSelectedRows);

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const handleHoldingClick = (holding: HoldingWithDetails) => navigate(`/holdings/${holding.id}`);

  const handleSelectRow = (rowKey: string) => {
    setSelectedRows((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(rowKey)) {
        newSet.delete(rowKey);
      } else {
        newSet.add(rowKey);
      }
      return newSet;
    });
  };

  const handleSelectAll = (selected: boolean) => {
    if (selected) {
      setSelectedRows(new Set(filteredAndSortedHoldings.map((h) => h.id)));
    } else {
      setSelectedRows(new Set());
    }
  };

  const clearFilters = () => {
    setSearchTerm('');
    clearAllFilters();
    setValueRange('all');
    setSortField('value');
    setSortDirection('desc');
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Holdings"
        subtitle="Explore all your financial positions"
        secondaryActions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Download className="h-4 w-4 mr-2" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem
                onClick={() => exportHoldingsData(filteredAndSortedHoldings, 'csv')}
              >
                Export as CSV
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => exportHoldingsData(filteredAndSortedHoldings, 'json')}
              >
                Export as JSON
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      {isLoading ? (
        <HoldingsLoadingSkeleton />
      ) : error ? (
        <Card>
          <CardContent className="py-12 text-center">
            <div className="text-muted-foreground">
              <AlertTriangle className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <h3 className="text-lg font-medium mb-2">Error loading holdings</h3>
              <p>Unable to load your holdings data. Please try again later.</p>
            </div>
          </CardContent>
        </Card>
      ) : holdings.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <div className="text-muted-foreground">
              <PieChart className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <h3 className="text-lg font-medium mb-2">No holdings found</h3>
              <p>You don't have any holdings yet. Connect your accounts to get started.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <HoldingsToolbar
            totalCount={holdings.length}
            filteredCount={filteredAndSortedHoldings.length}
            summaryStats={summaryStats}
            currency={currency}
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            filterBy={filterBy}
            filterByAccount={filterByAccount}
            filterByToken={filterByToken}
            filterByGroup={filterByGroup}
            valueRange={valueRange}
            groupBy={groupBy}
            viewMode={viewMode}
            tokenTypes={filterOptions.tokenTypes.map((type) => ({
              id: type.code,
              code: type.code,
              name: type.name,
            }))}
            accountOptions={filterOptions.accountOptions}
            institutionOptions={filterOptions.institutionOptions}
            tokenOptions={filterOptions.tokenOptions}
            groups={groups}
            updateFilter={updateFilter}
            setValueRange={setValueRange}
            setGroupBy={setGroupBy}
            setViewMode={setViewMode}
            clearFilters={clearFilters}
          />

          <Tabs value="holdings" className="w-full">
            <TabsContent value="holdings" className="space-y-6">
              {Object.entries(groupedHoldings).map(([groupName, groupHoldings]) => {
                const activeHoldings = groupHoldings.filter((h) => h.isActive);
                const groupValue = activeHoldings.reduce((sum, h) => sum + h.value, 0);
                return (
                  <div key={groupName}>
                    {groupBy !== 'none' && (
                      <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                        <Filter className="h-5 w-5" />
                        {groupName} ({activeHoldings.length} holdings •{' '}
                        <MoneyDisplay
                          value={groupValue}
                          token={baseCurrencyToken}
                          minimumFractionDigits={0}
                          maximumFractionDigits={0}
                        />
                        )
                      </h3>
                    )}

                    <BulkActionBar
                      selectedCount={selectedRows.size}
                      onEditSelected={() => setBulkEditGroupsModalOpen(true)}
                      onDeleteSelected={() => handleBulkDelete(selectedRows)}
                      isDeletePending={bulkDeleteHoldingsMutation.isPending}
                    />

                    {viewMode === 'cards' ? (
                      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                        {groupHoldings.map((holding) => (
                          <HoldingCard
                            key={holding.id}
                            holding={holding}
                            isSelected={selectedRows.has(holding.id)}
                            baseCurrencyToken={baseCurrencyToken}
                            onSelect={handleSelectRow}
                            onClick={handleHoldingClick}
                          />
                        ))}
                      </div>
                    ) : (
                      <HoldingsTable
                        holdings={groupHoldings}
                        baseCurrencyToken={baseCurrencyToken}
                        selectedRows={selectedRows}
                        onSort={handleSort}
                        onRowClick={handleHoldingClick}
                        onSelectRow={handleSelectRow}
                        onSelectAll={handleSelectAll}
                        renderActions={(holding) => (
                          <HoldingActionsMenu
                            holding={holding}
                            onToggleActive={handleToggleActive}
                            onDelete={handleDeleteHolding}
                          />
                        )}
                      />
                    )}
                  </div>
                );
              })}

              {filteredAndSortedHoldings.length === 0 && (
                <Card>
                  <CardContent className="py-12 text-center">
                    <div className="text-muted-foreground">
                      <Filter className="h-12 w-12 mx-auto mb-4 opacity-50" />
                      <h3 className="text-lg font-medium mb-2">No holdings found</h3>
                      <p>Try adjusting your filters or search terms.</p>
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}

      <BulkEditGroupsModal
        open={bulkEditGroupsModalOpen}
        onOpenChange={setBulkEditGroupsModalOpen}
        entityType="holding"
        selectedEntityIds={Array.from(selectedRows)}
        onSuccess={() => {
          utils.holdings.getWithDetails.invalidate();
          setSelectedRows(new Set());
          toast({
            title: 'Groups updated',
            description: 'Holding groups have been updated successfully.',
          });
        }}
      />
    </div>
  );
}
