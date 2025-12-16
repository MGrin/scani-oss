import {
  ArrowDown,
  Calendar,
  CheckCircle,
  ChevronRight,
  Clock,
  Edit,
  Plus,
  Repeat,
  Trash2,
  Workflow,
} from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { showError, useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

type ScheduleStepData =
  | { from: string; toHoldingId: string; amount: string }
  | { fromHoldingId: string; to: string; amount: string }
  | { fromHoldingId: string; toHoldingId: string; amount?: string; percent?: number }
  | { fromHoldingId: string; toHoldingId: string; amount?: string; percent?: number };

export function ScheduleDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [isCreateStepDialogOpen, setIsCreateStepDialogOpen] = useState(false);
  const [isDeleteStepDialogOpen, setIsDeleteStepDialogOpen] = useState(false);
  const [stepToDelete, setStepToDelete] = useState<string | null>(null);

  // Fetch schedule details
  const { data: schedule, isLoading: scheduleLoading } = trpc.schedules.getById.useQuery(
    { id: id! },
    { enabled: Boolean(id) }
  );

  // Fetch schedule steps
  const { data: steps, isLoading: stepsLoading } = trpc.schedules.getSteps.useQuery(
    { id: id! },
    { enabled: Boolean(id) }
  );

  // Fetch schedule types
  const { data: scheduleTypes } = trpc.scheduleTypes.getAll.useQuery();

  // Fetch schedule step types
  const { data: scheduleStepTypes } = trpc.scheduleStepTypes.getAll.useQuery();

  // Fetch holdings for dropdowns
  const { data: holdings } = trpc.holdings.getWithDetails.useQuery();

  // Delete schedule mutation
  const deleteSchedule = trpc.schedules.delete.useMutation({
    onSuccess: () => {
      toast({
        title: 'Schedule deleted',
        description: 'The schedule has been deleted successfully.',
      });
      navigate('/schedules');
    },
    onError: (error) => showError(error, 'Deleting schedule'),
  });

  // Create schedule step mutation
  const createStep = trpc.schedules.createStep.useMutation({
    onSuccess: () => {
      utils.schedules.getSteps.invalidate({ id: id! });
      setIsCreateStepDialogOpen(false);
      toast({
        title: 'Step added',
        description: 'The schedule step has been added successfully.',
      });
    },
    onError: (error) => showError(error, 'Adding step'),
  });

  // Delete schedule step mutation
  const deleteStep = trpc.schedules.deleteStep.useMutation({
    onSuccess: () => {
      utils.schedules.getSteps.invalidate({ id: id! });
      setIsDeleteStepDialogOpen(false);
      setStepToDelete(null);
      toast({
        title: 'Step deleted',
        description: 'The schedule step has been deleted successfully.',
      });
    },
    onError: (error) => showError(error, 'Deleting step'),
  });

  const handleDeleteSchedule = () => {
    if (id) {
      deleteSchedule.mutate({ id });
    }
  };

  const handleDeleteStep = () => {
    if (stepToDelete && id) {
      deleteStep.mutate({ id: stepToDelete, scheduleId: id });
    }
  };

  const handleCreateStep = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    const typeId = formData.get('typeId') as string;
    const stepType = scheduleStepTypes?.find((t) => t.id === typeId);

    let data: ScheduleStepData;

    if (stepType?.code === 'inflow') {
      data = {
        from: formData.get('from') as string,
        toHoldingId: formData.get('toHoldingId') as string,
        amount: formData.get('amount') as string,
      };
    } else if (stepType?.code === 'outflow') {
      data = {
        fromHoldingId: formData.get('fromHoldingId') as string,
        to: formData.get('to') as string,
        amount: formData.get('amount') as string,
      };
    } else if (stepType?.code === 'transfer' || stepType?.code === 'conversion') {
      const usePercent = formData.get('usePercent') === 'percent';
      data = {
        fromHoldingId: formData.get('fromHoldingId') as string,
        toHoldingId: formData.get('toHoldingId') as string,
        ...(usePercent
          ? { percent: Number(formData.get('percent')) }
          : { amount: formData.get('amount') as string }),
      };
    } else {
      return;
    }

    createStep.mutate({
      scheduleId: id!,
      typeId,
      stepOrder: (steps?.length || 0) + 1,
      data,
    });
  };

  if (scheduleLoading || !schedule) {
    return (
      <div className="space-y-6">
        <PageHeader title="Loading..." />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const typeName = scheduleTypes?.find((t) => t.id === schedule.typeId)?.name || 'Unknown';

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title={schedule.name}
        subtitle={schedule.description || undefined}
        backButton={{
          onClick: () => navigate('/schedules'),
          label: 'Back to Schedules',
        }}
        primaryAction={{
          label: 'Add Step',
          onClick: () => setIsCreateStepDialogOpen(true),
          icon: <Plus className="h-4 w-4" />,
        }}
        secondaryActions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon">
                <Edit className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => setIsDeleteDialogOpen(true)}
                className="text-red-600"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete Schedule
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      {/* Schedule Info */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Workflow className="h-5 w-5" />
            Schedule Details
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="flex items-start gap-3">
              <Calendar className="h-5 w-5 text-muted-foreground mt-0.5" />
              <div>
                <p className="text-sm font-medium">Type</p>
                <p className="text-sm text-muted-foreground">{typeName}</p>
              </div>
            </div>
            {schedule.repetitiveCronPattern ? (
              <div className="flex items-start gap-3">
                <Clock className="h-5 w-5 text-muted-foreground mt-0.5" />
                <div>
                  <p className="text-sm font-medium">Cron Pattern</p>
                  <p className="text-sm text-muted-foreground font-mono">
                    {schedule.repetitiveCronPattern}
                  </p>
                </div>
              </div>
            ) : schedule.interval ? (
              <>
                <div className="flex items-start gap-3">
                  <Repeat className="h-5 w-5 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="text-sm font-medium">Interval</p>
                    <p className="text-sm text-muted-foreground">
                      {(() => {
                        const match = schedule.interval.match(/^(\d+)(d|w|M|y)$/);
                        if (!match || !match[1] || !match[2]) return schedule.interval;
                        const value = match[1];
                        const unit = match[2];
                        const unitNames: Record<string, string> = {
                          d: 'day',
                          w: 'week',
                          M: 'month',
                          y: 'year',
                        };
                        const unitName = unitNames[unit] || unit;
                        const plural = Number.parseInt(value, 10) !== 1 ? 's' : '';
                        return `Every ${value} ${unitName}${plural}`;
                      })()}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Calendar className="h-5 w-5 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="text-sm font-medium">Start Date</p>
                    <p className="text-sm text-muted-foreground">
                      {schedule.intervalStartDate
                        ? new Date(schedule.intervalStartDate).toLocaleDateString()
                        : 'Not set'}
                    </p>
                  </div>
                </div>
              </>
            ) : null}
            <div className="flex items-start gap-3">
              <CheckCircle className="h-5 w-5 text-muted-foreground mt-0.5" />
              <div>
                <p className="text-sm font-medium">Status</p>
                <p className="text-sm text-muted-foreground">
                  {schedule.isActive ? 'Active' : 'Inactive'}
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Schedule Flow */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Workflow className="h-5 w-5" />
            Schedule Flow
          </CardTitle>
        </CardHeader>
        <CardContent>
          {stepsLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24 w-full" />
              ))}
            </div>
          ) : !steps || steps.length === 0 ? (
            <div className="text-center py-12">
              <Workflow className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-semibold mb-2">No steps defined</h3>
              <p className="text-muted-foreground mb-4">
                Add steps to define the flow of monetary movements
              </p>
              <Button onClick={() => setIsCreateStepDialogOpen(true)}>
                <Plus className="mr-2 h-4 w-4" />
                Add First Step
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {steps.map((step, index) => (
                <div key={step.id}>
                  <ScheduleStepCard
                    step={step}
                    stepNumber={index + 1}
                    scheduleStepTypes={scheduleStepTypes}
                    holdings={holdings}
                    onDelete={() => {
                      setStepToDelete(step.id);
                      setIsDeleteStepDialogOpen(true);
                    }}
                  />
                  {index < steps.length - 1 && (
                    <div className="flex justify-center py-2">
                      <ArrowDown className="h-6 w-6 text-muted-foreground" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Step Dialog */}
      <CreateStepDialog
        isOpen={isCreateStepDialogOpen}
        onClose={() => setIsCreateStepDialogOpen(false)}
        scheduleStepTypes={scheduleStepTypes}
        holdings={holdings}
        onSubmit={handleCreateStep}
        isPending={createStep.isPending}
      />

      {/* Delete Schedule Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Schedule</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{schedule.name}"? This will also delete all schedule
              steps. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setIsDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDeleteSchedule}
              disabled={deleteSchedule.isPending}
            >
              {deleteSchedule.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Step Dialog */}
      <Dialog open={isDeleteStepDialogOpen} onOpenChange={setIsDeleteStepDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Step</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this step? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setIsDeleteStepDialogOpen(false);
                setStepToDelete(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={handleDeleteStep}
              disabled={deleteStep.isPending}
            >
              {deleteStep.isPending ? 'Deleting...' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Create Step Dialog Component
function CreateStepDialog({
  isOpen,
  onClose,
  scheduleStepTypes,
  holdings,
  onSubmit,
  isPending,
}: {
  isOpen: boolean;
  onClose: () => void;
  scheduleStepTypes:
    | Array<{
        id: string;
        code: string;
        name: string;
        description?: string | null;
      }>
    | undefined;
  holdings:
    | Array<{
        id: string;
        token: { symbol: string };
        account: { name: string };
      }>
    | undefined;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  isPending: boolean;
}) {
  const [selectedStepTypeId, setSelectedStepTypeId] = useState<string>('');
  const [amountType, setAmountType] = useState<'fixed' | 'percent'>('fixed');

  const selectedStepType = scheduleStepTypes?.find((t) => t.id === selectedStepTypeId);

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add Schedule Step</DialogTitle>
          <DialogDescription>Define a new step in the schedule flow</DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit}>
          <div className="space-y-4">
            {/* Step Type Selector */}
            <div>
              <Label htmlFor="typeId">Step Type</Label>
              <Select
                name="typeId"
                required
                value={selectedStepTypeId}
                onValueChange={setSelectedStepTypeId}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select step type" />
                </SelectTrigger>
                <SelectContent>
                  {scheduleStepTypes?.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      <div>
                        <div className="font-medium">{type.name}</div>
                        {type.description && (
                          <div className="text-xs text-muted-foreground">{type.description}</div>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Dynamic Fields Based on Step Type */}
            {selectedStepType?.code === 'inflow' && (
              <>
                <div>
                  <Label htmlFor="from">From (Counterparty)</Label>
                  <Input id="from" name="from" required placeholder="e.g., Employer, Client" />
                  <p className="text-xs text-muted-foreground mt-1">
                    Name of the person or entity sending money
                  </p>
                </div>
                <div>
                  <Label htmlFor="toHoldingId">To (Holding)</Label>
                  <Select name="toHoldingId" required>
                    <SelectTrigger>
                      <SelectValue placeholder="Select destination holding" />
                    </SelectTrigger>
                    <SelectContent>
                      {holdings?.map((holding) => (
                        <SelectItem key={holding.id} value={holding.id}>
                          {holding.account.name} - {holding.token.symbol}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="amount">Amount</Label>
                  <Input
                    id="amount"
                    name="amount"
                    type="number"
                    step="0.01"
                    required
                    placeholder="0.00"
                  />
                </div>
              </>
            )}

            {selectedStepType?.code === 'outflow' && (
              <>
                <div>
                  <Label htmlFor="fromHoldingId">From (Holding)</Label>
                  <Select name="fromHoldingId" required>
                    <SelectTrigger>
                      <SelectValue placeholder="Select source holding" />
                    </SelectTrigger>
                    <SelectContent>
                      {holdings?.map((holding) => (
                        <SelectItem key={holding.id} value={holding.id}>
                          {holding.account.name} - {holding.token.symbol}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="to">To (Counterparty)</Label>
                  <Input id="to" name="to" required placeholder="e.g., Netflix, Rent" />
                  <p className="text-xs text-muted-foreground mt-1">
                    Name of the person or entity receiving money
                  </p>
                </div>
                <div>
                  <Label htmlFor="amount">Amount</Label>
                  <Input
                    id="amount"
                    name="amount"
                    type="number"
                    step="0.01"
                    required
                    placeholder="0.00"
                  />
                </div>
              </>
            )}

            {(selectedStepType?.code === 'transfer' || selectedStepType?.code === 'conversion') && (
              <>
                <div>
                  <Label htmlFor="fromHoldingId">From (Holding)</Label>
                  <Select name="fromHoldingId" required>
                    <SelectTrigger>
                      <SelectValue placeholder="Select source holding" />
                    </SelectTrigger>
                    <SelectContent>
                      {holdings?.map((holding) => (
                        <SelectItem key={holding.id} value={holding.id}>
                          {holding.account.name} - {holding.token.symbol}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="toHoldingId">To (Holding)</Label>
                  <Select name="toHoldingId" required>
                    <SelectTrigger>
                      <SelectValue placeholder="Select destination holding" />
                    </SelectTrigger>
                    <SelectContent>
                      {holdings?.map((holding) => (
                        <SelectItem key={holding.id} value={holding.id}>
                          {holding.account.name} - {holding.token.symbol}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {selectedStepType?.code === 'transfer' && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Both holdings must have the same token
                    </p>
                  )}
                </div>
                <div>
                  <Label>Amount Type</Label>
                  <Select
                    name="usePercent"
                    value={amountType}
                    onValueChange={(value) => setAmountType(value as 'fixed' | 'percent')}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="fixed">Fixed Amount</SelectItem>
                      <SelectItem value="percent">Percentage of Inflow</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {amountType === 'fixed' ? (
                  <div>
                    <Label htmlFor="amount">Amount</Label>
                    <Input
                      id="amount"
                      name="amount"
                      type="number"
                      step="0.01"
                      required
                      placeholder="0.00"
                    />
                  </div>
                ) : (
                  <div>
                    <Label htmlFor="percent">Percentage</Label>
                    <Input
                      id="percent"
                      name="percent"
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      required
                      placeholder="0"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      Percentage of the inflow amount in this schedule
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isPending || !selectedStepTypeId}>
              {isPending ? 'Adding...' : 'Add Step'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Schedule Step Card Component
function ScheduleStepCard({
  step,
  stepNumber,
  scheduleStepTypes,
  holdings,
  onDelete,
}: {
  step: {
    id: string;
    typeId: string;
    data?: unknown;
    stepOrder: number;
  };
  stepNumber: number;
  scheduleStepTypes: Array<{ id: string; code: string; name: string }> | undefined;
  holdings:
    | Array<{
        id: string;
        token: { symbol: string };
        account: { name: string };
      }>
    | undefined;
  onDelete: () => void;
}) {
  const stepType = scheduleStepTypes?.find((t) => t.id === step.typeId);
  const stepData = step.data as Record<string, unknown>;

  const getHoldingName = (holdingId: string) => {
    const holding = holdings?.find((h) => h.id === holdingId);
    return holding ? `${holding.account.name} (${holding.token.symbol})` : holdingId;
  };

  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-3">
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-primary text-primary-foreground text-sm font-bold">
                {stepNumber}
              </div>
              <h4 className="text-lg font-semibold">{stepType?.name || 'Unknown'}</h4>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
              {stepType?.code === 'inflow' && (
                <>
                  <div>
                    <span className="text-muted-foreground">From:</span>
                    <span className="ml-2 font-medium">{stepData.from as string}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">To:</span>
                    <span className="ml-2 font-medium">
                      {getHoldingName(stepData.toHoldingId as string)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Amount:</span>
                    <span className="ml-2 font-medium">{stepData.amount as string}</span>
                  </div>
                </>
              )}

              {stepType?.code === 'outflow' && (
                <>
                  <div>
                    <span className="text-muted-foreground">From:</span>
                    <span className="ml-2 font-medium">
                      {getHoldingName(stepData.fromHoldingId as string)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">To:</span>
                    <span className="ml-2 font-medium">{stepData.to as string}</span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Amount:</span>
                    <span className="ml-2 font-medium">{stepData.amount as string}</span>
                  </div>
                </>
              )}

              {(stepType?.code === 'transfer' || stepType?.code === 'conversion') && (
                <>
                  <div>
                    <span className="text-muted-foreground">From:</span>
                    <span className="ml-2 font-medium">
                      {getHoldingName(stepData.fromHoldingId as string)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">To:</span>
                    <span className="ml-2 font-medium">
                      {getHoldingName(stepData.toHoldingId as string)}
                    </span>
                  </div>
                  <div>
                    <span className="text-muted-foreground">
                      {stepData.amount ? 'Amount:' : 'Percent:'}
                    </span>
                    <span className="ml-2 font-medium">
                      {stepData.amount
                        ? (stepData.amount as string)
                        : `${stepData.percent as number}%`}
                    </span>
                  </div>
                </>
              )}
            </div>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon">
                <ChevronRight className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onDelete} className="text-red-600">
                <Trash2 className="mr-2 h-4 w-4" />
                Delete Step
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  );
}
