import {
  Calendar,
  ChevronRight,
  Clock,
  Filter,
  MoreHorizontal,
  Plus,
  Trash2,
  Workflow,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { Skeleton } from '@/components/ui/skeleton';
import { showError, useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

type Schedule = {
  id: string;
  userId: string;
  name: string;
  description: string | null;
  repetitiveCronPattern: string;
  typeId: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export function Schedules() {
  const navigate = useNavigate();
  const [_selectedSchedule, setSelectedSchedule] = useState<Schedule | null>(null);
  const [_isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [scheduleToDelete, setScheduleToDelete] = useState<Schedule | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState<string>('all');

  const { toast } = useToast();
  const utils = trpc.useUtils();

  // Fetch schedules
  const { data: schedules, isLoading } = trpc.schedules.getAll.useQuery();

  // Fetch schedule types
  const { data: scheduleTypes } = trpc.scheduleTypes.getAll.useQuery();

  // Update schedule mutation (TODO: implement edit dialog)
  // const updateSchedule = trpc.schedules.update.useMutation({
  //   onSuccess: () => {
  //     utils.schedules.getAll.invalidate();
  //     setIsEditDialogOpen(false);
  //     setSelectedSchedule(null);
  //     toast({
  //       title: 'Schedule updated',
  //       description: 'Your schedule has been updated successfully.',
  //     });
  //   },
  //   onError: (error) => showError(error, 'Updating schedule'),
  // });

  // Delete schedule mutation
  const deleteSchedule = trpc.schedules.delete.useMutation({
    onSuccess: () => {
      utils.schedules.getAll.invalidate();
      setIsDeleteDialogOpen(false);
      setScheduleToDelete(null);
      toast({
        title: 'Schedule deleted',
        description: 'The schedule has been deleted successfully.',
      });
    },
    onError: (error) => showError(error, 'Deleting schedule'),
  });

  // Filter schedules
  const filteredSchedules = useMemo(() => {
    if (!schedules) return [];

    return schedules.filter((schedule) => {
      const matchesSearch =
        schedule.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (schedule.description?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false);
      const matchesType = selectedType === 'all' || schedule.typeId === selectedType;

      return matchesSearch && matchesType;
    });
  }, [schedules, searchQuery, selectedType]);

  // Format cron pattern to human-readable (TODO: use in display)
  // const formatCronPattern = (pattern: string) => {
  //   // Basic cron pattern formatting - can be enhanced
  //   const parts = pattern.split(' ');
  //   if (parts.length === 5) {
  //     const [minute] = parts;

  //     if (pattern === '0 0 * * *') return 'Daily at midnight';
  //     if (pattern === '0 9 * * *') return 'Daily at 9:00 AM';
  //     if (pattern === '0 0 * * 0') return 'Weekly on Sunday';
  //     if (pattern === '0 0 1 * *') return 'Monthly on the 1st';

  //     return `Every ${minute === '*' ? 'minute' : minute === '0' ? 'hour' : `${minute} minutes`}`;
  //   }
  //   return pattern;
  // };

  const handleDeleteSchedule = () => {
    if (scheduleToDelete) {
      deleteSchedule.mutate({ id: scheduleToDelete.id });
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Schedules" subtitle="Manage your recurring monetary movement patterns" />

        <div className="grid gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Schedules"
        subtitle="Manage your recurring monetary movement patterns"
        primaryAction={{
          label: 'Create Schedule',
          onClick: () => navigate('/schedules/new'),
          icon: <Plus className="h-4 w-4" />,
        }}
      />

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <Input
                placeholder="Search schedules..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full"
              />
            </div>
            <Select value={selectedType} onValueChange={setSelectedType}>
              <SelectTrigger className="w-full sm:w-[200px]">
                <Filter className="mr-2 h-4 w-4" />
                <SelectValue placeholder="Filter by type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {scheduleTypes?.map((type) => (
                  <SelectItem key={type.id} value={type.id}>
                    {type.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Schedules List */}
      {filteredSchedules.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-center">
            <Workflow className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No schedules found</h3>
            <p className="text-muted-foreground mb-4">
              {searchQuery || selectedType !== 'all'
                ? 'Try adjusting your filters'
                : 'Create your first recurring schedule to get started'}
            </p>
            {!searchQuery && selectedType === 'all' && (
              <Button onClick={() => navigate('/schedules/new')}>
                <Plus className="mr-2 h-4 w-4" />
                Create Schedule
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {filteredSchedules.map((schedule) => (
            <ScheduleCard
              key={schedule.id}
              schedule={schedule}
              scheduleTypes={scheduleTypes}
              onView={() => navigate(`/schedules/${schedule.id}`)}
              onEdit={() => {
                setSelectedSchedule(schedule);
                setIsEditDialogOpen(true);
              }}
              onDelete={() => {
                setScheduleToDelete(schedule);
                setIsDeleteDialogOpen(true);
              }}
            />
          ))}
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Schedule</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{scheduleToDelete?.name}"? This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setIsDeleteDialogOpen(false);
                setScheduleToDelete(null);
              }}
            >
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
    </div>
  );
}

// Schedule Card Component
function ScheduleCard({
  schedule,
  scheduleTypes,
  onView,
  onEdit,
  onDelete,
}: {
  schedule: Schedule;
  scheduleTypes: Array<{ id: string; name: string }> | undefined;
  onView: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const typeName = scheduleTypes?.find((t) => t.id === schedule.typeId)?.name || 'Unknown';

  return (
    <Card className="hover:shadow-md transition-shadow cursor-pointer" onClick={onView}>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <CardTitle className="text-lg flex items-center gap-2">
              <Workflow className="h-5 w-5" />
              {schedule.name}
            </CardTitle>
            {schedule.description && (
              <p className="text-sm text-muted-foreground mt-1">{schedule.description}</p>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" size="icon">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onView();
                }}
              >
                <ChevronRight className="mr-2 h-4 w-4" />
                View Details
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
              >
                Edit
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete();
                }}
                className="text-red-600"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-4 text-sm">
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            <span className="font-medium">{typeName}</span>
          </div>
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">{schedule.repetitiveCronPattern}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
